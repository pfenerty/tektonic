import type { TaskCacheSpec, TaskStepSpec } from "./task";

/**
 * Context passed from {@link TaskDef} to each backend method.
 *
 * Carries only what every backend needs whatever it stores archives in: the task the
 * cache is attached to, and the project's fallback step image. A backend that needs a
 * more specific image owns that default itself (see {@link GcsBackend}), so adding a
 * backend never grows this interface.
 */
export interface BackendCtx {
    /** Name of the task this cache belongs to. */
    taskName: string;
    /**
     * Project-level fallback image for injected cache steps, used when neither
     * {@link TaskCacheSpec.image} nor the backend's own default names one.
     *
     * It is a marker resolved at synth time against the project's `injectedStepImage`,
     * requiring only `sh`. A backend whose steps need more — nushell, zstd, a cloud CLI —
     * asks for it with `injectedImageRef('nushell', …)` instead, so the project's image
     * is still what runs and a missing capability fails synthesis rather than the pod.
     */
    defaultImage: string;
}

/**
 * Strategy interface for cache backends.
 *
 * Implement this interface to create a custom cache backend:
 *
 * ```ts
 * class S3Backend implements CacheBackend {
 *   readonly type = 's3';
 *   readonly needsPvcWorkspace = false;
 *   constructor(private readonly opts: { bucket: string; image?: string }) {}
 *   restoreStep(spec, ctx) {
 *     return { name: `restore-${spec.name}-cache`, image: this._image(spec, ctx), script: ... };
 *   }
 *   saveStep(spec, ctx) { ... }
 *   private _image(spec: TaskCacheSpec, ctx: BackendCtx) {
 *     return spec.image ?? this.opts.image ?? injectedImageRef('nushell', 'zstd');
 *   }
 * }
 * ```
 *
 * Step images resolve in one order, and every backend should honour it:
 * `spec.image` → the backend's own default → the project's injected-step image. A backend
 * with no image needs of its own ends that chain at `ctx.defaultImage`; one that has them
 * ends it at `injectedImageRef(...capabilities)`, which resolves to the same project image
 * while declaring what that image must provide.
 *
 * Pass an instance via `TaskCacheSpec.backend`. When omitted, {@link PvcBackend} is used.
 */
export interface CacheBackend {
    /** Discriminator string (e.g. `'pvc'`, `'gcs'`). */
    readonly type: string;
    /**
     * True when this backend stores cache archives on a PVC workspace.
     * {@link TaskDef} uses this to auto-register the cache workspace on the task
     * and to correctly wire finally-task workspaces.
     */
    readonly needsPvcWorkspace: boolean;
    /** Returns the step that restores the cache at the start of the task. */
    restoreStep(spec: TaskCacheSpec, ctx: BackendCtx): TaskStepSpec;
    /** Returns the step that saves the cache at the end of the task (or in a finally pod). */
    saveStep(spec: TaskCacheSpec, ctx: BackendCtx): TaskStepSpec;
}
