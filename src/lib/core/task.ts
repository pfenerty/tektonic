import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import {
    TEKTON_API_V1,
    DEFAULT_STEP_SECURITY_CONTEXT,
    DEFAULT_STEP_RESOURCES,
    DEFAULT_BASE_IMAGE,
    DEFAULT_GCS_CACHE_IMAGE,
} from "../constants";
import { Param } from "./param";
import { Workspace } from "./workspace";
import { Result } from "./result";
import { PvcBackend } from "../cache/pvc-backend";
import type { StatusReporter } from "./status-reporter";
import type { CacheBackend, BackendCtx } from "./cache-backend";

/** Specification for a single step within a Tekton Task. */
export interface TaskStepSpec {
    /** Step name (must be unique within the task). */
    name: string;
    /** Container image to run for this step. */
    image: string;
    /** Entrypoint command override. */
    command?: string[];
    /** Arguments passed to the entrypoint. */
    args?: string[];
    /** Inline script executed by the step. */
    script?: string;
    /** Working directory for the step. */
    workingDir?: string;
    /** Environment variables injected into the step container. */
    env?: {
        name: string;
        value?: string;
        valueFrom?: { secretKeyRef: { name: string; key: string } };
    }[];
    /** Controls behaviour when this step fails. `continue` lets subsequent steps run. */
    onError?: "continue" | "stopAndFail";
    /** CPU/memory requests and limits for this step (overrides stepTemplate computeResources). */
    computeResources?: {
        requests?: { cpu?: string; memory?: string; "ephemeral-storage"?: string };
        limits?: { cpu?: string; memory?: string; "ephemeral-storage"?: string };
    };
    /** Per-step container securityContext override. Applied on top of the task stepTemplate. */
    securityContext?: Record<string, unknown>;
    /** Volume mounts for this step. Each entry must reference a volume declared in the task's `volumes` array or a workspace-backed volume. */
    volumeMounts?: {
        name: string;
        mountPath: string;
        readOnly?: boolean;
        subPath?: string;
    }[];
}

/**
 * Declares a cache entry for a task. The library injects restore and save
 * steps automatically around the user's steps, following the same hash-based
 * hit/miss strategy as GitLab CI's `cache:` keyword.
 */
export interface TaskCacheSpec {
    /**
     * Human-readable name for this cache, used in step names and log output.
     * For example, `"npm"` produces steps named `restore-npm-cache` and `save-npm-cache`.
     * Required.
     */
    name: string;
    /**
     * Files (relative to workingDir) whose combined content determines the cache key.
     * An empty array produces a fixed hash, meaning the cache always hits after the
     * first run — useful for tool-managed caches like vulnerability databases.
     */
    key: string[];
    /** Paths (relative to workingDir) to restore on hit and save on miss. */
    paths: string[];
    /**
     * Workspace (PVC) where cache entries are stored. Auto-added to task workspaces if absent.
     * Required for PVC backends. Ignored when `backend` is set to GCS.
     */
    workspace?: Workspace;
    /** Image for the injected restore/save steps. Defaults to `'alpine'`. */
    image?: string;
    /**
     * Compress the cache into a single zstd archive (`.tar.zst`) instead of copying
     * path trees directly. Reduces NFS I/O from thousands of file operations to one
     * read/write. Requires the step image to have `tar` with `--zstd` support and nushell.
     */
    compress?: boolean;
    /**
     * Working directory for the injected restore and save steps. Paths in `key` and
     * `paths` are resolved relative to this directory. Typically set to the Tekton
     * workspace expression, e.g. `$(workspaces.workspace.path)`.
     */
    workingDir?: string;
    /**
     * zstd compression level (1–19). Lower levels are faster and use less memory.
     * Level 1 uses ~1 MB working memory and still achieves ~2.5× compression.
     * Only applies when `compress` is `true`. Defaults to `1`.
     */
    compressionLevel?: number;
    /**
     * Explicit `computeResources` for the injected cache restore and save steps,
     * overriding the stepTemplate default. Useful for constraining memory when the
     * build step consumes most of the node's RAM.
     */
    computeResources?: {
        requests?: { cpu?: string; memory?: string; "ephemeral-storage"?: string };
        limits?: { cpu?: string; memory?: string; "ephemeral-storage"?: string };
    };
    /**
     * Maximum number of cache archive entries to keep per workspace. During save,
     * entries older than the newest `maxEntries` are deleted. Defaults to `3`.
     * Set to `0` to disable eviction.
     */
    maxEntries?: number;
    /**
     * Strategy for running the cache save step.
     *
     * - `"step"` (default) — save runs as a step within the build pod. Fastest,
     *   but shares node memory with the build steps; can cause OOM on memory-
     *   intensive builds (e.g. large Go projects on constrained nodes).
     *
     * - `"finally"` — save runs as a separate Tekton *finally* task in its own
     *   pod. The build pod is fully terminated (and its memory reclaimed) before
     *   compression starts. Adds ~10–15 s scheduling overhead.
     */
    saveStrategy?: "step" | "finally";
    /**
     * Always overwrite the cache archive on save, even if one already exists
     * for the current hash. Use this for tool-managed caches where the tool
     * updates its data in-place (e.g. grype vulnerability database).
     * Defaults to `false`.
     */
    forceSave?: boolean;
    /**
     * Cache storage backend. Defaults to PVC-based caching (using the
     * `workspace` property) when omitted.
     *
     * Set to `{ type: 'gcs', bucket: '...' }` to store cache archives in
     * Google Cloud Storage instead of a PVC. Requires GKE Workload Identity.
     */
    backend?: CacheBackend;
    /**
     * Use multi-threaded zstd compression (`-T0`, auto-detect threads) instead
     * of single-threaded (`-T1`). Faster on nodes with spare CPU but uses more
     * memory. Only applies when `compress` is `true`.
     *
     * Defaults to `false` for PVC backends (constrained environments) and
     * `true` for GCS backends (robust environments).
     */
    multiThreadCompression?: boolean;
}

/**
 * Specification for a sidecar container that runs alongside a task's steps.
 *
 * Sidecars start before the steps begin and are terminated after all steps complete.
 * Common uses: database containers for integration tests, docker-in-docker, local
 * service stubs.
 *
 * Unlike steps, sidecars do not support `onError` and are not sequenced by Tekton.
 */
export interface TaskSidecarSpec {
    /** Sidecar name (must be unique within the task). */
    name: string;
    /** Container image to run. */
    image: string;
    /** Entrypoint command override. */
    command?: string[];
    /** Arguments passed to the entrypoint. */
    args?: string[];
    /** Inline script executed by the sidecar (requires an image with a shell). */
    script?: string;
    /** Working directory for the sidecar container. */
    workingDir?: string;
    /** Environment variables injected into the sidecar container. */
    env?: {
        name: string;
        value?: string;
        valueFrom?: { secretKeyRef: { name: string; key: string } };
    }[];
    /** CPU/memory requests and limits for this sidecar. */
    computeResources?: {
        requests?: { cpu?: string; memory?: string; "ephemeral-storage"?: string };
        limits?: { cpu?: string; memory?: string; "ephemeral-storage"?: string };
    };
    /** Per-container security context override. */
    securityContext?: Record<string, unknown>;
    /**
     * Probe used by Tekton to determine when the sidecar is ready to serve traffic.
     * Follows the Kubernetes `v1.Probe` schema.
     */
    readinessProbe?: Record<string, unknown>;
}

/**
 * A Kubernetes volume available for mounting in task steps or sidecars.
 *
 * Follows the Kubernetes `v1.Volume` schema — `name` is required; all other
 * fields are passed through as-is. Common volume types: `emptyDir`, `configMap`,
 * `secret`, `persistentVolumeClaim`.
 *
 * @example
 * ```ts
 * // Shared tmpfs between a step and a sidecar
 * { name: 'shared', emptyDir: { medium: 'Memory' } }
 * ```
 */
export interface TaskVolumeSpec {
    name: string;
    [key: string]: unknown;
}

/** Minimum contract shared by all task-like nodes in a pipeline. */
export interface TaskLike {
    readonly name: string;
    readonly synthesizable: boolean;
    readonly needs: TaskLike[];
    readonly params: Param[];
    readonly workspaces: Workspace[];
    _toPipelineTaskSpec(runAfterNames: string[], namePrefix?: string): Record<string, unknown>;
}

/** Options for constructing a {@link TaskDef}. */
export interface TaskOptions {
    /** Task name used in Tekton manifests and pipeline task references. */
    name: string;
    /** Parameters accepted by this task. */
    params?: Param[];
    /** Workspaces required by this task. */
    workspaces?: Workspace[];
    /** Ordered list of steps the task executes. */
    steps: TaskStepSpec[];
    /** Tasks that must complete before this task runs (dependency graph edges). */
    needs?: TaskLike[];
    /** Override or extend the default step template (merged with security context defaults). */
    stepTemplate?: Record<string, unknown>;
    /**
     * Status context string reported to the external system (e.g. `"ci/test"`).
     * When set together with `statusReporter`, the reporter's `finalStep` is
     * automatically appended to this task's steps at synthesis time.
     */
    statusContext?: string;
    /** Reporter used to generate the final-status step for this task. */
    statusReporter?: StatusReporter;
    /**
     * Cache declarations for this task. For each entry the library injects a
     * restore step before the user's steps and a save step after them.
     * The cache workspace is auto-registered if not already in `workspaces`.
     */
    caches?: TaskCacheSpec[];
    /** Results this task produces. Each result is bound to the task name at construction time. */
    results?: Result[];
    /**
     * Sidecar containers that run alongside this task's steps for the duration of the task pod.
     * Start before steps begin; terminated after all steps complete.
     */
    sidecars?: TaskSidecarSpec[];
    /**
     * Additional Kubernetes volumes made available for mounting in steps and sidecars.
     * Volumes declared here supplement (not replace) workspace-backed volumes.
     * Follows the Kubernetes `v1.Volume` schema — `name` is required.
     */
    volumes?: TaskVolumeSpec[];
}

/**
 * A Tekton Task definition.
 *
 * Tasks are the unit of work in a Tekton pipeline. Each task declares its
 * params, workspaces, and steps. The {@link needs} array defines the dependency
 * graph — pipelines automatically discover transitive dependencies and set
 * `runAfter` ordering.
 *
 * All steps inherit a secure-by-default `stepTemplate` that drops all
 * capabilities and enables seccomp. Override via the `stepTemplate` option.
 */
export class TaskDef implements TaskLike {
    readonly synthesizable = true as const;
    readonly name: string;
    readonly params: Param[];
    readonly workspaces: Workspace[];
    readonly steps: TaskStepSpec[];
    /** Tasks that must complete before this task runs. */
    readonly needs: TaskLike[];
    readonly stepTemplate?: Record<string, unknown>;
    /** Status context reported to the external system. */
    readonly statusContext?: string;
    /** Reporter that generates the final-status step. */
    readonly statusReporter?: StatusReporter;
    /** Cache declarations — restore/save steps are injected at synthesis time. */
    readonly caches: TaskCacheSpec[];
    /** Results this task produces, bound to this task's name at construction time. */
    readonly results: Result[];
    /** Sidecar containers that run alongside steps for the task pod's lifetime. */
    readonly sidecars: TaskSidecarSpec[];
    /** Additional Kubernetes volumes available for mounting in steps and sidecars. */
    readonly volumes: TaskVolumeSpec[];

    constructor(opts: TaskOptions) {
        this.name = opts.name;
        // Auto-merge statusReporter.requiredParams into task params (user params take precedence)
        const base = opts.params ?? [];
        const reporterParams = opts.statusReporter?.requiredParams ?? [];
        const seen = new Map<string, Param>();
        for (const p of [...base, ...reporterParams]) {
            if (!seen.has(p.name)) seen.set(p.name, p);
        }
        this.params = [...seen.values()];
        this.workspaces = [...(opts.workspaces ?? [])];
        this.steps = opts.steps;
        this.needs = opts.needs ?? [];
        this.stepTemplate = opts.stepTemplate;
        this.statusContext = opts.statusContext ?? opts.name;
        this.statusReporter = opts.statusReporter;
        this.caches = opts.caches ?? [];
        // Auto-register workspace for PVC-backed caches. Non-PVC backends manage their own storage.
        for (const c of this.caches) {
            const backend = c.backend ?? new PvcBackend();
            if (!backend.needsPvcWorkspace || !c.workspace) continue;
            if (!this.workspaces.some((w) => w.name === c.workspace!.name)) {
                (this.workspaces as Workspace[]).push(c.workspace);
            }
        }
        this.results = opts.results ?? [];
        for (const r of this.results) r._bindToTask(this.name);
        this.sidecars = opts.sidecars ?? [];
        this.volumes = opts.volumes ?? [];
    }

    /**
     * Synthesizes the Tekton Task resource into the given cdk8s scope.
     *
     * @param stepSecurityContext - Additional container-level security context fields merged on
     *   top of `DEFAULT_STEP_SECURITY_CONTEXT`. Supplied by `TektonProject` from the project's
     *   `defaultStepSecurityContext` option. The task's own `stepTemplate.securityContext` (if
     *   any) takes precedence over this via the spread in stepTemplate.
     */
    synth(
        scope: Construct,
        namespace: string,
        namePrefix?: string,
        stepSecurityContext?: Record<string, unknown>,
    ): void {
        const resourceName = namePrefix
            ? `${namePrefix}-${this.name}`
            : this.name;
        const baseStepSecContext = {
            ...DEFAULT_STEP_SECURITY_CONTEXT,
            ...(stepSecurityContext ?? {}),
        };
        const ctx: BackendCtx = { defaultBaseImage: DEFAULT_BASE_IMAGE, defaultGcsCacheImage: DEFAULT_GCS_CACHE_IMAGE };
        const restoreSteps = this.caches.map((c) =>
            (c.backend ?? new PvcBackend()).restoreStep(c, this.name, ctx),
        );
        const saveSteps = this.caches
            .filter((c) => c.saveStrategy !== "finally")
            .map((c) => (c.backend ?? new PvcBackend()).saveStep(c, this.name, ctx));
        const reporterStep =
            this.statusReporter && this.statusContext
                ? [this.statusReporter.finalStep(this.statusContext)]
                : [];
        const allSteps = [
            ...restoreSteps,
            ...this.steps,
            ...saveSteps,
            ...reporterStep,
        ];
        const steps = allSteps.map((s) => {
            const { securityContext, ...rest } = s as TaskStepSpec;
            return securityContext ? { ...rest, securityContext } : rest;
        });
        new ApiObject(scope, this.name, {
            apiVersion: TEKTON_API_V1,
            kind: "Task",
            metadata: { name: resourceName, namespace },
            spec: {
                stepTemplate: {
                    securityContext: baseStepSecContext,
                    computeResources: DEFAULT_STEP_RESOURCES,
                    ...(this.stepTemplate ?? {}),
                },
                ...(this.params.length > 0 && {
                    params: this.params.map((p) => p.toSpec()),
                }),
                ...(this.workspaces.length > 0 && {
                    workspaces: this.workspaces.map((w) => w.toSpec()),
                }),
                ...(this.results.length > 0 && {
                    results: this.results.map((r) => r.toSpec()),
                }),
                steps,
                ...(this.sidecars.length > 0 && {
                    sidecars: this.sidecars,
                }),
                ...(this.volumes.length > 0 && {
                    volumes: this.volumes,
                }),
            },
        });
    }

    /**
     * Returns standalone Task objects for caches that use `saveStrategy: "finally"`.
     * These tasks are intended to be wired into the pipeline's `finally` block so
     * they run in their own pod after the build pod has terminated.
     */
    getCacheFinallyTasks(): Task[] {
        const ctx: BackendCtx = { defaultBaseImage: DEFAULT_BASE_IMAGE, defaultGcsCacheImage: DEFAULT_GCS_CACHE_IMAGE };
        return this.caches
            .filter((c) => c.saveStrategy === "finally")
            .map((c) => {
                const backend = c.backend ?? new PvcBackend();
                // PVC backends prepend the cache workspace so hash files survive across pods.
                // Non-PVC backends (GCS etc.) use only the source task's workspaces.
                const taskWorkspaces = backend.needsPvcWorkspace
                    ? [c.workspace!, ...this.workspaces.filter((w) => w.name !== c.workspace!.name)]
                    : [...this.workspaces];
                return new TaskDef({
                    name: `save-${c.name}-cache-${this.name}`,
                    workspaces: taskWorkspaces,
                    steps: [backend.saveStep(c, this.name, ctx)],
                    stepTemplate: this.stepTemplate,
                });
            });
    }

    /** @internal Generates the pipeline task spec used inside a Pipeline resource. */
    _toPipelineTaskSpec(
        runAfterNames: string[],
        namePrefix?: string,
    ): Record<string, unknown> {
        const taskRefName = namePrefix
            ? `${namePrefix}-${this.name}`
            : this.name;
        const spec: Record<string, unknown> = {
            name: this.name,
            taskRef: { kind: "Task", name: taskRefName },
        };
        if (this.params.length > 0) {
            spec.params = this.params.map((p) => ({
                name: p.name,
                value: p.pipelineExpression ?? `$(params.${p.name})`,
            }));
        }
        if (this.workspaces.length > 0) {
            spec.workspaces = this.workspaces.map((w) => ({
                name: w.name,
                workspace: w.name,
            }));
        }
        if (runAfterNames.length > 0) {
            spec.runAfter = runAfterNames;
        }
        return spec;
    }
}

// Backward-compatible aliases — preserves all existing `new Task()` and
// `instanceof Task` usage without any changes to call sites.
export const Task = TaskDef;
export type Task = TaskDef;
