import type { TaskCacheSpec, TaskStepSpec } from "./task";

/**
 * Context passed from {@link TaskDef} to each backend method.
 * Carries the project-level image defaults so backends don't import constants directly.
 */
export interface BackendCtx {
    defaultBaseImage: string;
    defaultGcsCacheImage: string;
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
 *   restoreStep(spec, taskName, ctx) { ... }
 *   saveStep(spec, taskName, ctx) { ... }
 * }
 * ```
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
    restoreStep(spec: TaskCacheSpec, taskName: string, ctx: BackendCtx): TaskStepSpec;
    /** Returns the step that saves the cache at the end of the task (or in a finally pod). */
    saveStep(spec: TaskCacheSpec, taskName: string, ctx: BackendCtx): TaskStepSpec;
}
