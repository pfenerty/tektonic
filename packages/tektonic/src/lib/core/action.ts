import { Param } from "./param";
import { Workspace } from "./workspace";
import { Result } from "./result";
import type { TaskStepSpec, TaskCacheSpec, TaskVolumeSpec } from "./task";
import { sh, Script } from "../script";
import { ActionArtifactSource } from "./artifact";

/**
 * Directory every action's declared outputs live in, shared by every step in the pod.
 *
 * Tekton steps are separate containers: only mounted volumes cross the step boundary, so a
 * file one step writes to its own filesystem is gone by the time the next step starts.
 * Tektonic mounts a pod-scoped `emptyDir` here on every step of a task that composes an
 * action with outputs, which is what makes `${syft.outputs.sbom}` resolvable downstream.
 */
export const ACTION_OUTPUT_DIR = "/tektonic/actions" as const;

/** Name of the `emptyDir` volume tektonic injects to back {@link ACTION_OUTPUT_DIR}. */
export const ACTION_VOLUME_NAME = "tektonic-actions" as const;

/** Tekton's per-result size cap. A larger output has to travel as a workspace file. */
const RESULT_SIZE_LIMIT = 4096;

/** Step names must be a DNS label so Tekton accepts the generated container name. */
const STEP_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/**
 * A typed handle to a file an {@link Action} produces inside the pod.
 *
 * Stringifies to the absolute path the producing step writes, so a downstream step
 * interpolates it with no convention to remember:
 *
 * ```ts
 * const sbom = syft({ image: 'app:1.0' });
 * const scan = grype({ sbom: sbom.outputs.sbom });   // typed, not a path string
 * // inside grype's body: `grype sbom:${inputs.sbom}` → `grype sbom:/tektonic/actions/sbom-sbom.json`
 * ```
 *
 * The path is pod-scoped. Crossing a *pod* boundary — handing the file to a downstream
 * Task — is a separate, explicit step: {@link toResult} or {@link toWorkspace}.
 */
export class ActionOutput {
    constructor(
        /** Instance name of the action that produces this output. */
        readonly action: string,
        /** Logical output name, as declared in the action definition. */
        readonly name: string,
        /** Absolute in-pod path the producing step writes to. */
        readonly path: string,
        /** File name component of {@link path}, used as the default promotion destination. */
        readonly fileName: string,
        /** Image the producing action runs in; the default for a promotion step. */
        private readonly producerImage?: string,
    ) {}

    /** The in-pod path, so the handle interpolates directly into a step body. */
    toString(): string {
        return this.path;
    }

    /**
     * Promotes this output across the pod boundary into a Tekton {@link Result}, so a
     * downstream *task* can read it.
     *
     * Returns an action to compose into the same task's `steps` — the promotion is a step,
     * stated at the call site, never something the framework does behind your back. The
     * result is contributed to the composing task's `results` automatically.
     *
     * Results cap at 4KB; the generated step fails with that message rather than letting
     * Tekton truncate. For anything larger use {@link toWorkspace}.
     *
     * ```ts
     * const sarifPath = new Result({ name: 'sarif' });
     * new Task({ steps: [scan, scan.outputs.report.toResult(sarifPath)] });
     * ```
     */
    toResult(result: Result, opts: ActionPromotionOptions = {}): Action<never> {
        const image = this.resolvePromotionImage(opts, "toResult");
        return definePromotion({
            name: opts.name ?? `promote-${this.name}-to-result`,
            image,
            results: [result],
            body: sh`
                src='${this.path}'
                if [ ! -f "$src" ]; then
                  log "action '${this.action}' declared output '${this.name}' but wrote no file at $src"
                  exit 1
                fi
                bytes=$(wc -c < "$src")
                if [ "$bytes" -gt ${String(RESULT_SIZE_LIMIT)} ]; then
                  log "output '${this.name}' is $bytes bytes; a Tekton result caps at ${String(RESULT_SIZE_LIMIT)} — promote it to a workspace file instead"
                  exit 1
                fi
                cp "$src" '${result.path}'
            `,
        });
    }

    /**
     * Promotes this output across the pod boundary into a file on a shared workspace, so a
     * downstream *task* can read it — the route for anything past a result's 4KB cap.
     *
     * Returns an action to compose into the same task's `steps`; the workspace is contributed
     * to the composing task automatically. `dest` is relative to the workspace root and
     * defaults to this output's file name.
     */
    toWorkspace(
        workspace: Workspace,
        dest?: string,
        opts: ActionPromotionOptions = {},
    ): Action<never> {
        const image = this.resolvePromotionImage(opts, "toWorkspace");
        const target = workspace.at(dest ?? this.fileName);
        return definePromotion({
            name: opts.name ?? `promote-${this.name}-to-workspace`,
            image,
            workspaces: [workspace],
            body: sh`
                src='${this.path}'
                if [ ! -f "$src" ]; then
                  log "action '${this.action}' declared output '${this.name}' but wrote no file at $src"
                  exit 1
                fi
                dest='${target}'
                mkdir -p "$(dirname "$dest")"
                cp "$src" "$dest"
            `,
        });
    }

    /**
     * Declares this output as a cross-pod {@link TaskArtifact}, for the composing task's
     * `produces`.
     *
     * The sibling of {@link toWorkspace} with the declaration added: the file still lands on
     * a workspace, but a named producer and named consumers now exist, so synthesis can
     * check that anyone reading it is ordered after this task. Reach for `toWorkspace` only
     * for a file nobody in the pipeline consumes.
     *
     * Unlike {@link toResult} and {@link toWorkspace} this returns a declaration rather than
     * an {@link Action}: the copy step is injected by the composing task, which is the only
     * thing that knows the workspace and store the artifact lives on.
     *
     * ```ts
     * const build = new Task({
     *   name: 'build',
     *   workspaces: [ws],
     *   steps: [compile],
     *   produces: { dist: compile.outputs.bundle.toArtifact() },
     * });
     * ```
     */
    toArtifact(opts: { image?: string } = {}): ActionArtifactSource {
        return new ActionArtifactSource(
            this.action,
            this.name,
            this.path,
            this.fileName,
            opts.image ?? this.producerImage,
        );
    }

    private resolvePromotionImage(opts: ActionPromotionOptions, method: string): string {
        const image = opts.image ?? this.producerImage;
        if (!image) {
            throw new Error(
                `Action '${this.action}': ${method}('${this.name}') has no image to run in — ` +
                    `the producing action declares none, so pass { image } explicitly`,
            );
        }
        return image;
    }
}

/** Options for a promotion step produced by {@link ActionOutput.toResult} / {@link ActionOutput.toWorkspace}. */
export interface ActionPromotionOptions {
    /** Step name within the composing task. Defaults to `promote-<output>-to-<result|workspace>`. */
    name?: string;
    /**
     * Image the copy runs in. Defaults to the producing action's image — the one image the
     * pod is already pulling — and needs only `/bin/sh` with `cp` and `wc`.
     */
    image?: string;
}

/** The typed output handles of an action, keyed by the names its definition declares. */
export type ActionOutputs<ON extends string> = { readonly [K in ON]: ActionOutput };

/**
 * A step as written inside an action definition.
 *
 * Identical to {@link TaskStepSpec} except that `image` is optional: it falls back to the
 * instance's `image` override and then to the definition's own, so a single-image action
 * states its image once.
 */
export type ActionStepSpec = Omit<TaskStepSpec, "image"> & { image?: string };

/** Something an action contributes upward, stated directly or derived from its inputs. */
export type ActionContribution<In, T> = T[] | ((inputs: In) => T[]);

/** What {@link ActionDefinition.steps} is handed when the composing task expands the action. */
export interface ActionCtx<In, ON extends string> {
    /** Instance name of this action within the composing task; prefixes its step names. */
    readonly name: string;
    /** The typed inputs this instance was constructed with. */
    readonly inputs: In;
    /** Typed path handles for this instance's declared outputs. */
    readonly outputs: ActionOutputs<ON>;
    /** Resolved image for this instance's steps, if the definition or the instance set one. */
    readonly image?: string;
    /** Directory this instance's outputs live in. */
    readonly outputDir: string;
}

/**
 * The definition of a reusable, versioned unit of work that renders to one or more steps
 * **inside** a task's pod.
 *
 * This is the action half of the job/action split: a {@link TaskDef} is the unit of
 * *scheduling* (one Tekton Task, one pod, one status context), an action is the unit of
 * *reuse inside* one. See {@link defineAction}.
 */
export interface ActionDefinition<In, ON extends string = never> {
    /** Stable identifier, e.g. `'syft-sbom'`. Also the default instance name. */
    name: string;
    /** Version of the action's contract, for pinning and (eventually) publication. */
    version?: string;
    /** Human-readable description, surfaced in generated docs and errors. */
    description?: string;
    /** Default image for this action's steps; a step or the instance may override it. */
    image?: string;
    /**
     * Files this action produces, as `logicalName: fileName`. Each becomes a typed
     * {@link ActionOutput} at `<{@link ACTION_OUTPUT_DIR}>/<instance>-<fileName>`, on a volume
     * shared by every step in the pod.
     */
    outputs?: Record<ON, string>;
    /** Params this action needs; merged upward into the composing task. */
    params?: ActionContribution<In, Param>;
    /** Workspaces this action needs; merged upward into the composing task. */
    workspaces?: ActionContribution<In, Workspace>;
    /** Caches this action needs; merged upward into the composing task. */
    caches?: ActionContribution<In, TaskCacheSpec>;
    /** Extra volumes this action needs; merged upward into the composing task. */
    volumes?: ActionContribution<In, TaskVolumeSpec>;
    /** Results this action writes; merged upward into the composing task. */
    results?: ActionContribution<In, Result>;
    /** Renders this action to steps. Called once, when the instance is constructed. */
    steps(ctx: ActionCtx<In, ON>): ActionStepSpec[];
}

/** Per-instance options accepted alongside an action's typed inputs. */
export interface ActionOptions {
    /**
     * Instance name within the composing task. Defaults to the definition's name; required
     * when the same action is composed twice into one task, since step names derive from it.
     */
    name?: string;
    /** Image override for this instance's steps. */
    image?: string;
}

/**
 * A constructed action instance: typed outputs, resolved steps, and the params, workspaces,
 * caches, volumes and results it contributes to the task that composes it.
 *
 * Instances come from the factory {@link defineAction} returns, not from `new Action(...)`.
 *
 * Not to be confused with {@link HubTaskRef}, which is a *remote, job-sized* unit — a whole
 * Tekton catalog Task, one more pod in the pipeline graph. An action is pod-internal: it
 * never becomes a node in the DAG, has no status context of its own, and shares the composing
 * task's params, workspaces and filesystem.
 */
export class Action<ON extends string = never> {
    /** Instance name within the composing task; prefixes every step name it contributes. */
    readonly name: string;
    /** Name of the definition this instance came from. */
    readonly actionName: string;
    /** Version of the definition this instance came from, if it declares one. */
    readonly version?: string;
    /** Typed path handles for this instance's declared outputs. */
    readonly outputs: ActionOutputs<ON>;
    /** Steps this action contributes, already name-prefixed and image-resolved. */
    readonly steps: TaskStepSpec[];
    /** Params contributed upward into the composing task. */
    readonly params: Param[];
    /** Workspaces contributed upward into the composing task. */
    readonly workspaces: Workspace[];
    /** Caches contributed upward into the composing task. */
    readonly caches: TaskCacheSpec[];
    /** Volumes contributed upward into the composing task. */
    readonly volumes: TaskVolumeSpec[];
    /** Results contributed upward into the composing task. */
    readonly results: Result[];

    /** @internal Constructed by the factory {@link defineAction} returns. */
    constructor(def: ActionDefinition<unknown, ON>, inputs: unknown, opts: ActionOptions = {}) {
        this.name = opts.name ?? def.name;
        this.actionName = def.name;
        this.version = def.version;
        if (!STEP_NAME_RE.test(this.name)) {
            throw new Error(
                `Action '${def.name}': instance name '${this.name}' is not a DNS label ` +
                    `(lowercase alphanumerics and '-'), and step names derive from it`,
            );
        }
        const image = opts.image ?? def.image;
        const outputs: Record<string, ActionOutput> = {};
        for (const [logical, fileName] of Object.entries(def.outputs ?? {})) {
            outputs[logical] = new ActionOutput(
                this.name,
                logical,
                `${ACTION_OUTPUT_DIR}/${this.name}-${String(fileName)}`,
                String(fileName),
                image,
            );
        }
        this.outputs = outputs as ActionOutputs<ON>;
        this.params = resolveContribution(def.params, inputs);
        this.workspaces = resolveContribution(def.workspaces, inputs);
        this.caches = resolveContribution(def.caches, inputs);
        this.volumes = resolveContribution(def.volumes, inputs);
        this.results = resolveContribution(def.results, inputs);

        const seen = new Set<string>();
        this.steps = def
            .steps({
                name: this.name,
                inputs,
                outputs: this.outputs,
                image,
                outputDir: ACTION_OUTPUT_DIR,
            })
            .map((step) => {
                if (!STEP_NAME_RE.test(step.name)) {
                    throw new Error(
                        `Action '${this.name}' (${def.name}): step name '${step.name}' is not a ` +
                            `DNS label (lowercase alphanumerics and '-')`,
                    );
                }
                if (seen.has(step.name)) {
                    throw new Error(
                        `Action '${this.name}' (${def.name}): duplicate step name '${step.name}'`,
                    );
                }
                seen.add(step.name);
                const stepImage = step.image ?? image;
                if (!stepImage) {
                    throw new Error(
                        `Action '${this.name}' (${def.name}): step '${step.name}' has no image — ` +
                            `set 'image' on the definition, pass { image } to the instance, or set ` +
                            `it on the step`,
                    );
                }
                // Steps are namespaced by the instance so two instances never collide, except
                // where the author already named the step after the action — the usual
                // single-step case, which would otherwise read `syft-syft`.
                const stepName = step.name === this.name ? step.name : `${this.name}-${step.name}`;
                return { ...step, image: stepImage, name: stepName };
            });
    }

    /** True when this action declares outputs, so the composing task mounts the shared volume. */
    get usesOutputVolume(): boolean {
        return Object.keys(this.outputs).length > 0;
    }

    /**
     * @internal Returns a copy of this instance with every step rewritten by `merge`.
     *
     * Used by {@link taskPreset} so a project's step defaults — compute resources, base env,
     * a security context — reach a library action's steps as they reach hand-written ones.
     * The instance is copied rather than mutated: the same action object may be composed into
     * more than one task, and a preset applies to one of them.
     */
    _withSteps(merge: (step: TaskStepSpec) => TaskStepSpec): Action<ON> {
        const clone = Object.create(Object.getPrototypeOf(this) as object) as Action<ON>;
        Object.assign(clone, this, { steps: this.steps.map(merge) });
        return clone;
    }
}

function resolveContribution<In, T>(
    contribution: ActionContribution<In, T> | undefined,
    inputs: In,
): T[] {
    if (!contribution) return [];
    return typeof contribution === "function" ? contribution(inputs) : [...contribution];
}

/**
 * Defines a reusable action: a typed, versioned unit of work that renders to steps inside a
 * composing task's pod.
 *
 * Returns a factory taking the action's declared inputs, so consumers get compile-time
 * checking instead of a params bag, and typed output handles instead of a path convention:
 *
 * ```ts
 * const syft = defineAction<{ image: string }, 'sbom'>({
 *   name: 'syft-sbom',
 *   version: '1.0.0',
 *   image: 'ghcr.io/example/syft:1.42.3',
 *   outputs: { sbom: 'sbom.json' },
 *   steps: ({ inputs, outputs }) => [
 *     { name: 'sbom', script: sh`syft "${inputs.image}" -o cyclonedx-json=${outputs.sbom}` },
 *   ],
 * });
 *
 * const sbom = syft({ image: 'app:1.0' });                  // instance, outputs available now
 * new Task({ name: 'scan', steps: [sbom, grype({ sbom: sbom.outputs.sbom })] });
 * ```
 *
 * The composing task owns everything cross-cutting: an action's steps are ordinary steps by
 * the time they are synthesized, so they take the exit-code contract, the step template, the
 * project's pull policy and the status reporter exactly as hand-written steps do.
 */
export function defineAction<In = void, ON extends string = never>(
    def: ActionDefinition<In, ON>,
): (inputs: In, opts?: ActionOptions) => Action<ON> {
    return (inputs: In, opts: ActionOptions = {}) =>
        new Action<ON>(def as ActionDefinition<unknown, ON>, inputs, opts);
}

/** Builds the single-step action behind an {@link ActionOutput} promotion. */
function definePromotion(spec: {
    name: string;
    image: string;
    body: Script;
    results?: Result[];
    workspaces?: Workspace[];
}): Action<never> {
    return defineAction<void, never>({
        name: spec.name,
        image: spec.image,
        description: "Promotes an action output across the pod boundary",
        results: spec.results ?? [],
        workspaces: spec.workspaces ?? [],
        // Named after the instance, so the step is `promote-sbom-to-result` — or whatever the
        // caller named it — rather than a prefixed variant of an internal step name.
        steps: ({ name }) => [{ name, script: spec.body }],
    })();
}
