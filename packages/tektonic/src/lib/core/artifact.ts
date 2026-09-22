import type { Workspace } from "./workspace";
import type { TaskLike, TaskStepSpec } from "./task";
import { injectedImageRef } from "./injected-image";
import { sh } from "../script";

/**
 * Directory, relative to a workspace root, that declared artifacts are published under.
 *
 * Laid out as `<workspace>/.tektonic/artifacts/<producing task>/<artifact name>/<file>`, so
 * exactly one task writes any given subtree — which is what makes an artifact safe on a
 * workspace several tasks mount, unlike a bare agreed-upon path.
 */
export const ARTIFACT_DIR = ".tektonic/artifacts" as const;

/** Artifact names become step names, so they must be a DNS label. */
const ARTIFACT_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/**
 * An {@link ActionOutput} promoted to a declared, cross-pod artifact.
 *
 * Produced by {@link ActionOutput.toArtifact} and only meaningful as a value in a task's
 * `produces`. Unlike `toResult()`/`toWorkspace()` — which return an {@link Action} the
 * author composes into `steps` — this one is a *declaration*: the copy step is injected by
 * the producing task, because only the task knows which workspace and store the artifact
 * lives on.
 */
export class ActionArtifactSource {
    /** @internal Constructed by {@link ActionOutput.toArtifact}. */
    constructor(
        /** Instance name of the action that writes the file. */
        readonly action: string,
        /** Logical output name on that action. */
        readonly output: string,
        /** Absolute in-pod path the action writes. */
        readonly path: string,
        /** File name component of {@link path}. */
        readonly fileName: string,
        /** Image the publish step runs in; defaults to the producing action's. */
        readonly image?: string,
    ) {}
}

/**
 * The object form of an {@link ArtifactSource}, for an artifact that needs to say more about
 * itself than where its bytes are.
 *
 * Only worth reaching for when one of the extra fields applies; `produces: { dist: 'out/app.tar' }`
 * stays the ordinary way to declare one.
 */
export interface ArtifactSpec {
    /** Where the bytes are — the same string or promoted output the bare form takes. */
    from: string | ActionArtifactSource;
    /**
     * Whether TEP-0147 provenance calls this artifact a *build output* rather than a
     * by-product.
     *
     * This is the one bit Tekton Chains reads: an output is a SLSA byproduct unless it is
     * marked `buildOutput`, at which point Chains treats it as a **subject** of the build —
     * the thing the attestation is *about*. Mark the release artifact; leave coverage
     * reports, logs and SBOM side-files alone. Defaults to `false`.
     *
     * Has no effect unless provenance emission is on (`artifactProvenance` on the task or
     * the project), since it is alpha and needs the cluster's `enable-artifacts` flag.
     */
    buildOutput?: boolean;
}

/**
 * What a task may declare in `produces`: an action output promoted with
 * {@link ActionOutput.toArtifact}, a path a hand-written step wrote, or an
 * {@link ArtifactSpec} wrapping either with extra declarations.
 *
 * A path may be absolute or relative to the step's working directory, and may name a file
 * or a directory — it is copied wholesale. Globs are not expanded: name the directory.
 */
export type ArtifactSource = string | ActionArtifactSource | ArtifactSpec;

/** Narrows an {@link ArtifactSource} to its object form. */
function isArtifactSpec(source: ArtifactSource): source is ArtifactSpec {
    return typeof source === "object" && !(source instanceof ActionArtifactSource);
}

/**
 * A typed handle to a file (or directory) one task publishes for another to read.
 *
 * Reached through its producing task — `build.artifacts.dist` — and stringifying to the path
 * the *consumer* sees, so no step body hardcodes the artifact layout:
 *
 * ```ts
 * const build = new Task({ name: 'build', workspaces: [ws], steps: [compile],
 *                          produces: { dist: 'target/app.tar' } });
 *
 * const test = new Task({
 *   name: 'test',
 *   needs: [build],
 *   consumes: [build.artifacts.dist],
 *   steps: [{ name: 'run', image: 'alpine', script: sh`tar xf ${build.artifacts.dist}` }],
 * });
 * ```
 *
 * The handle carries its producer, so {@link Pipeline} can fail synthesis when a consumer
 * names an artifact nothing in the pipeline produces, or one whose producer is not ordered
 * before it. That check is the point of the declaration; the copying is incidental.
 *
 * An artifact is run-scoped and crosses a pod boundary. Its pod-internal counterpart is
 * {@link ActionOutput} — "output" is always pod-internal, "artifact" is always cross-pod.
 */
export class TaskArtifact {
    /** Logical name, as declared in the producing task's `produces`. */
    readonly name: string;
    /** The task that publishes this artifact. */
    readonly producer: TaskLike;
    /** Name of the producing task, as it appears in the artifact's storage path. */
    readonly producerName: string;
    /** Producer-side path the publish step copies from. */
    readonly sourcePath: string;
    /** Final path component, preserved so the consumer reads a recognisable name. */
    readonly fileName: string;
    /** Workspace this artifact is stored on, for a store that uses one. */
    readonly workspace?: Workspace;
    /** Store that moves the bytes and decides where the consumer reads them. */
    readonly store: ArtifactStore;
    /** Image the publish step runs in, when the source named one. */
    readonly publishImage?: string;
    /** Instance name of the action that produces this artifact, when it came from one. */
    readonly action?: string;
    /**
     * Whether TEP-0147 provenance marks this artifact a build output rather than a
     * by-product. See {@link ArtifactSpec.buildOutput}; `false` unless the declaration said so.
     */
    readonly buildOutput: boolean;

    /** @internal Constructed by {@link TaskDef} from its `produces` declaration. */
    constructor(opts: {
        name: string;
        source: ArtifactSource;
        producer: TaskLike;
        store: ArtifactStore;
        workspace?: Workspace;
    }) {
        if (!ARTIFACT_NAME_RE.test(opts.name)) {
            throw new Error(
                `Task '${opts.producer.name}': artifact name '${opts.name}' is not a DNS label ` +
                    `(lowercase alphanumerics and '-'), and step names derive from it`,
            );
        }
        this.name = opts.name;
        this.producer = opts.producer;
        this.producerName = opts.producer.name;
        this.store = opts.store;
        this.workspace = opts.workspace;
        const spec = isArtifactSpec(opts.source) ? opts.source : undefined;
        const from = spec ? spec.from : (opts.source as string | ActionArtifactSource);
        this.buildOutput = spec?.buildOutput ?? false;
        if (typeof from === "string") {
            this.sourcePath = from;
            this.fileName = baseName(from) || opts.name;
        } else {
            this.sourcePath = from.path;
            this.fileName = from.fileName;
            this.publishImage = from.image;
            this.action = from.action;
        }
    }

    /** The path a consuming task reads this artifact at. */
    get path(): string {
        return this.store.path(this);
    }

    /** The consumer-visible path, so the handle interpolates directly into a step body. */
    toString(): string {
        return this.path;
    }
}

/** Last path segment of `p`, ignoring a trailing slash. */
function baseName(p: string): string {
    const parts = p.split("/").filter(s => s.length > 0 && s !== ".");
    return parts.length ? parts[parts.length - 1] : "";
}

/** Context passed from {@link TaskDef} to each {@link ArtifactStore} method. */
export interface ArtifactStoreCtx {
    /** Name of the task the step is being injected into — the producer for a publish step,
     * the consumer for a fetch step. */
    taskName: string;
    /**
     * Project-level fallback image for the injected copy steps, as
     * {@link BackendCtx.defaultImage} is for caches: a marker resolved at synth time against
     * the project's `injectedStepImage`, requiring only `sh`. A store whose steps need more
     * asks for it with `injectedImageRef('nushell', …)` instead.
     */
    defaultImage: string;
}

/**
 * Strategy interface for artifact storage — the seam between *declaring* a producer/consumer
 * relationship and *moving the bytes*.
 *
 * Deliberately the same restore/save shape as {@link CacheBackend}: a step injected at the
 * end of the producer, a step injected at the start of the consumer, and a path the consumer
 * reads. {@link WorkspaceArtifactStore} is the default and keeps everything on the workspace
 * the pipeline already binds; a store that uploads to object storage implements the same
 * three methods and nothing above it changes.
 *
 * It is *not* a {@link CacheBackend}: a cache is content-addressed and reused across runs, an
 * artifact is run-scoped with exactly one writer. See docs/adr/0001-artifacts-and-dependencies.md.
 *
 * ```ts
 * class BucketStore implements ArtifactStore {
 *   readonly type = 'bucket';
 *   readonly needsWorkspace = false;
 *   constructor(private readonly opts: { bucket: string }) {}
 *   path(a: TaskArtifact) { return `/tektonic/artifacts/${a.producerName}/${a.name}/${a.fileName}`; }
 *   publishStep(a, ctx) { return { name: `publish-${a.name}-artifact`, image: …, script: … }; }
 *   fetchStep(a, ctx)   { return { name: `fetch-${a.producerName}-${a.name}-artifact`, … }; }
 * }
 * ```
 */
export interface ArtifactStore {
    /** Discriminator string (e.g. `'workspace'`, `'s3'`). */
    readonly type: string;
    /**
     * True when this store keeps artifacts on a workspace. The producing task then resolves
     * one (its only workspace, or `artifactWorkspace`) and every consumer auto-mounts it.
     */
    readonly needsWorkspace: boolean;
    /** The path a consuming task reads the artifact at. */
    path(artifact: TaskArtifact): string;
    /** Step injected at the end of the producing task, copying the declared path out. */
    publishStep(artifact: TaskArtifact, ctx: ArtifactStoreCtx): TaskStepSpec;
    /**
     * Step injected at the start of a consuming task, making the artifact readable at
     * {@link path}. Return `undefined` when the store needs no step there.
     */
    fetchStep(artifact: TaskArtifact, ctx: ArtifactStoreCtx): TaskStepSpec | undefined;
    /**
     * Stable location the artifact can be retrieved from, for TEP-0147 artifact provenance.
     *
     * Optional because it is only read when provenance emission is on, and because a store
     * that moves nothing has nothing better to say than the path: omit it and the emitter
     * falls back to `file://` + {@link path}. A store that uploads should implement it — a
     * `gs://…` URI is retrievable after the pod is gone, and a pod-local path is not.
     */
    uri?(artifact: TaskArtifact): string;
}

/**
 * The default {@link ArtifactStore}: a per-producer subtree of the workspace the pipeline
 * already binds.
 *
 * The publish step copies the declared path to
 * `<workspace>/.tektonic/artifacts/<task>/<name>/<file>`; the consumer reads it there, so no
 * bytes move a second time. Because the subtree is keyed by producing task and artifact
 * name, it has exactly one writer — the property a bare shared path lacks, and the reason
 * an artifact is not subject to the race {@link Pipeline.flagSharedWorkspaceCaches} defends
 * caches against.
 *
 * The fetch step copies nothing and instead asserts the artifact is there. That turns the
 * case where a producer ran but published nothing — a `when` that skipped it, a step that
 * exited early — into a named failure at the top of the consumer, rather than a
 * file-not-found somewhere in the middle of it.
 *
 * It inherits the workspace's constraints: one RWO PVC, so the tasks sharing it cannot be
 * scheduled across nodes. Lifting that is what a store-backed implementation is for.
 */
export class WorkspaceArtifactStore implements ArtifactStore {
    readonly type = "workspace" as const;
    readonly needsWorkspace = true as const;

    path(artifact: TaskArtifact): string {
        return `${this.dir(artifact)}/${artifact.fileName}`;
    }

    publishStep(artifact: TaskArtifact, ctx: ArtifactStoreCtx): TaskStepSpec {
        const dest = this.path(artifact);
        return {
            name: `publish-${artifact.name}-artifact`,
            image: artifact.publishImage ?? ctx.defaultImage,
            script: sh`
                src='${artifact.sourcePath}'
                if [ ! -e "$src" ]; then
                  log "task '${ctx.taskName}' declares artifact '${artifact.name}' but wrote nothing at $src"
                  exit 1
                fi
                dest='${dest}'
                # One writer per subtree, so clearing it is safe and keeps a re-run of the
                # same task from merging into a previous run's tree.
                rm -rf "$dest"
                mkdir -p '${this.dir(artifact)}'
                cp -R "$src" "$dest"
            `,
        };
    }

    fetchStep(artifact: TaskArtifact, ctx: ArtifactStoreCtx): TaskStepSpec {
        const path = this.path(artifact);
        return {
            name: `fetch-${artifact.producerName}-${artifact.name}-artifact`,
            image: ctx.defaultImage,
            script: sh`
                path='${path}'
                if [ ! -e "$path" ]; then
                  log "task '${ctx.taskName}' consumes artifact '${artifact.name}' from task '${artifact.producerName}', but nothing was published at $path"
                  exit 1
                fi
            `,
        };
    }

    /** Directory holding one artifact, keyed by producing task so it has a single writer. */
    private dir(artifact: TaskArtifact): string {
        const ws = artifact.workspace;
        if (!ws) {
            throw new Error(
                `Artifact '${artifact.name}' on task '${artifact.producerName}' has no workspace, ` +
                    `which the '${this.type}' store requires`,
            );
        }
        return ws.at(ARTIFACT_DIR, artifact.producerName, artifact.name);
    }
}

/** The {@link ArtifactStoreCtx} a task hands its store, with the project's injected image. */
export function artifactStoreCtx(taskName: string): ArtifactStoreCtx {
    return { taskName, defaultImage: injectedImageRef() };
}
