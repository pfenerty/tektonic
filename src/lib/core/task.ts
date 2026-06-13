import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import {
    TEKTON_API_V1,
    DEFAULT_STEP_SECURITY_CONTEXT,
    DEFAULT_STEP_RESOURCES,
    DEFAULT_BASE_IMAGE,
    DEFAULT_GCS_CACHE_IMAGE,
    DEFAULT_GCS_COMPRESSION_LEVEL,
} from "../constants";
import { Param } from "./param";
import { Workspace } from "./workspace";
import { Result } from "./result";
import type { StatusReporter } from "./status-reporter";
import type { CacheBackend, GcsCacheBackend } from "./cache-backend";

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
    needs?: TaskDef[];
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
    readonly needs: TaskDef[];
    readonly stepTemplate?: Record<string, unknown>;
    /** Status context reported to the external system. */
    readonly statusContext?: string;
    /** Reporter that generates the final-status step. */
    readonly statusReporter?: StatusReporter;
    /** Cache declarations — restore/save steps are injected at synthesis time. */
    readonly caches: TaskCacheSpec[];
    /** Results this task produces, bound to this task's name at construction time. */
    readonly results: Result[];

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
        // Auto-register each PVC cache's workspace if not already present.
        // GCS caches don't use a workspace for storage.
        for (const c of this.caches) {
            if (c.backend?.type === "gcs" || !c.workspace) continue;
            if (!this.workspaces.some((w) => w.name === c.workspace!.name)) {
                (this.workspaces as Workspace[]).push(c.workspace);
            }
        }
        this.results = opts.results ?? [];
        for (const r of this.results) r._bindToTask(this.name);
    }

    // ── Helpers ──────────────────────────────────────────────────────

    /** Returns the zstd thread flag for this cache spec. */
    private static _threadFlag(c: TaskCacheSpec): string {
        const multi = c.multiThreadCompression ?? c.backend?.type === "gcs";
        return multi ? "-T0" : "-T1";
    }

    /** Returns the nushell hash-computation expression for the given key files. */
    private static _hashExpr(c: TaskCacheSpec): string {
        if (c.key.length === 0) {
            return `let hash = ("" | hash sha256 | str substring 0..15)`;
        }
        const keyFileList = c.key.map((f) => `"${f}"`).join(", ");
        return `let hash = (
  [${keyFileList}]
  | each { |f| if ($f | path exists) { open --raw $f } else { "" } }
  | str join | hash sha256 | str substring 0..15
)`;
    }

    // ── PVC backend ────────────────────────────────────────────────

    /** Returns the hash-file path for a PVC-backed cache. */
    private static _pvcHashFilePath(c: TaskCacheSpec, taskName?: string): string {
        const wsPath = `$(workspaces.${c.workspace!.name}.path)`;
        if (c.saveStrategy === "finally") {
            // Write to the cache PVC so it survives across pods.
            return `${wsPath}/.cache-${c.name}-hash${taskName ? `-${taskName}` : ""}`;
        }
        // Pod-local path (default).
        return `/tekton/home/.cache-${c.name}-hash`;
    }

    private static _makePvcRestoreScript(c: TaskCacheSpec, taskName?: string): string {
        const wsName = c.workspace!.name;
        const wsPath = `$(workspaces.${wsName}.path)`;
        const hashFile = TaskDef._pvcHashFilePath(c, taskName);
        const threadFlag = TaskDef._threadFlag(c);
        const label = `restore-${c.name}-cache`;

        if (c.compress) {
            const hashExpr = TaskDef._hashExpr(c);
            return `#!/usr/bin/env nu
def log [msg: string] {
  print $"[(date now | format date '%H:%M:%S')] ${label}: ($msg)"
}

${hashExpr}
$hash | save -f ${hashFile}
let archive = $"${wsPath}/($hash).tar.zst"

if ($archive | path exists) {
  let archive_size = (ls $archive | get size.0)
  log $"hit ($hash) size=($archive_size)"
  let cache_paths = [${c.paths.map((p) => `"${p}"`).join(", ")}]
  for p in $cache_paths {
    if ($p | path exists) { ^chmod -R u+w $p; rm -rf $p }
  }
  let t0 = (date now)
  ^zstd -d ${threadFlag} -c $archive | ^tar xf - -o --no-same-permissions
  let elapsed = (((date now) - $t0) | into int) / 1_000_000_000
  log $"restored in ($elapsed)s"
} else {
  log $"miss ($hash)"
}`;
        }
        // Uncompressed PVC restore
        const keyFiles = c.key.join(" ");
        const copyPaths = c.paths
            .map(
                (p) =>
                    `  [ -e "$CACHE_DIR/${p}" ] && cp -r "$CACHE_DIR/${p}" "./${p}" || true`,
            )
            .join("\n");
        const hashCmd =
            c.key.length === 0
                ? `HASH=$(echo -n "" | sha256sum | cut -c1-16)`
                : `HASH=$(cat ${keyFiles} | sha256sum | cut -c1-16)`;
        return `#!/bin/sh
set -e
${hashCmd}
echo "$HASH" > ${hashFile}
CACHE_DIR="${wsPath}/$HASH"
if [ -d "$CACHE_DIR" ]; then
  echo "[$(date +%H:%M:%S)] ${label}: hit $HASH"
${copyPaths}
else
  echo "[$(date +%H:%M:%S)] ${label}: miss $HASH"
fi`;
    }

    private static _makePvcSaveScript(c: TaskCacheSpec, taskName?: string): string {
        const wsName = c.workspace!.name;
        const wsPath = `$(workspaces.${wsName}.path)`;
        const hashFile = TaskDef._pvcHashFilePath(c, taskName);
        const compressionLevel = c.compressionLevel ?? 1;
        const maxEntries = c.maxEntries ?? 3;
        const forceSave = c.forceSave ?? false;
        const threadFlag = TaskDef._threadFlag(c);
        const label = `save-${c.name}-cache`;

        if (c.compress) {
            const pathList = c.paths.map((p) => `"${p}"`).join(", ");
            const skipExisting = forceSave
                ? ""
                : `if ($archive | path exists) { log $"($hash) exists, skipping"; exit 0 }\n`;
            return `#!/usr/bin/env nu
def log [msg: string] {
  print $"[(date now | format date '%H:%M:%S')] ${label}: ($msg)"
}

let hash = (try { open --raw ${hashFile} | str trim } catch { "" })
if ($hash | is-empty) { log "no hash, skipping"; exit 0 }

let archive = $"${wsPath}/($hash).tar.zst"
${skipExisting}
let paths = [${pathList}] | where { |p| ($p | path exists) }
if ($paths | is-empty) { log "no paths to cache"; exit 0 }

for p in $paths { ^chmod -R u+w $p }

let max = ${maxEntries}
if $max > 0 {
  let entries = (try { ls ${wsPath}/*.tar.zst | sort-by modified | reverse | skip $max } catch { [] })
  for e in $entries { log $"evicting ($e.name | path basename)"; rm $e.name }
}

let uncompressed = ($paths | each { |p| try { du $p | get apparent.0 | into int } catch { 0 } } | math sum)
log $"compressing (($uncompressed / 1_000_000) | math round --precision 1)MB uncompressed ..."
let t0 = (date now)
^tar cf - ...$paths | ^zstd -${compressionLevel} ${threadFlag}${forceSave ? " -f" : ""} -o $archive
let elapsed = (((date now) - $t0) | into int) / 1_000_000_000
let compressed = (ls $archive | get size.0)
let ratio = ($uncompressed / ($compressed | into int) | math round --precision 1)
log $"saved ($compressed) ratio=($ratio)x in ($elapsed)s"`;
        }
        // Uncompressed PVC save
        const copyPaths = c.paths
            .map((p) => `  cp -r "./${p}" "$CACHE_DIR/${p}"`)
            .join("\n");
        const saveCondition = forceSave
            ? `echo "saving cache ($HASH)"\n  mkdir -p "$CACHE_DIR"\n${copyPaths}`
            : `if [ ! -d "$CACHE_DIR" ]; then\n  echo "saving cache ($HASH)"\n  mkdir -p "$CACHE_DIR"\n${copyPaths}\nfi`;
        return `#!/bin/sh
HASH=$(cat ${hashFile} 2>/dev/null || echo "")
[ -z "$HASH" ] && exit 0
CACHE_DIR="${wsPath}/$HASH"
${saveCondition}`;
    }

    // ── GCS backend ────────────────────────────────────────────────

    /** Returns the hash-file path for a GCS-backed cache. */
    private static _gcsHashFilePath(c: TaskCacheSpec, taskName?: string): string {
        if (c.saveStrategy === "finally") {
            return `/tekton/home/.cache-${c.name}-hash${taskName ? `-${taskName}` : ""}`;
        }
        return `/tekton/home/.cache-${c.name}-hash`;
    }

    private static _makeGcsRestoreScript(c: TaskCacheSpec, taskName?: string): string {
        const gcs = c.backend as GcsCacheBackend;
        const bucket = gcs.bucket;
        const prefix = gcs.prefix ?? "";
        const hashFile = TaskDef._gcsHashFilePath(c, taskName);
        const hashExpr = TaskDef._hashExpr(c);
        const threadFlag = TaskDef._threadFlag(c);
        const label = `restore-${c.name}-cache`;

        return `#!/usr/bin/env nu
def log [msg: string] {
  print $"[(date now | format date '%H:%M:%S')] ${label}: ($msg)"
}

${hashExpr}
$hash | save -f ${hashFile}

let object = $"${prefix}($hash).tar.zst"
let gcs_url = $"gs://${bucket}/($object)"
log $"checking ($gcs_url)"

let exists = ((^gcloud storage ls $gcs_url | complete).exit_code == 0)
if $exists {
  let size = (
    ^gcloud storage ls -l $gcs_url
    | lines | first | str trim | split words | first | into int
  )
  log $"hit ($hash) size=(($size / 1_000_000) | math round --precision 1)MB"
  let cache_paths = [${c.paths.map((p) => `"${p}"`).join(", ")}]
  for p in $cache_paths {
    if ($p | path exists) { ^chmod -R u+w $p; rm -rf $p }
  }
  log "downloading ..."
  let t0 = (date now)
  ^gcloud --verbosity=error storage cp $gcs_url - | ^zstd -d ${threadFlag} -c | ^tar xf - -o --no-same-permissions
  let elapsed = (((date now) - $t0) | into int) / 1_000_000_000
  let speed = (if $elapsed > 0 { ($size / 1_000_000) / $elapsed | math round --precision 1 } else { 0 })
  log $"restored in ($elapsed)s ($speed) MB/s"
} else {
  log $"miss ($hash) — object not found in bucket"
}`;
    }

    private static _makeGcsSaveScript(c: TaskCacheSpec, taskName?: string): string {
        const gcs = c.backend as GcsCacheBackend;
        const bucket = gcs.bucket;
        const prefix = gcs.prefix ?? "";
        const hashFile = TaskDef._gcsHashFilePath(c, taskName);
        const compressionLevel = c.compressionLevel ?? DEFAULT_GCS_COMPRESSION_LEVEL;
        const maxEntries = c.maxEntries ?? 3;
        const forceSave = c.forceSave ?? false;
        const threadFlag = TaskDef._threadFlag(c);
        const label = `save-${c.name}-cache`;
        const pathList = c.paths.map((p) => `"${p}"`).join(", ");
        const tmpDir = c.workingDir ?? "/tmp";

        const skipExisting = forceSave
            ? ""
            : `let already_exists = ((^gcloud storage ls $gcs_url | complete).exit_code == 0)
if $already_exists { log $"($hash) exists, skipping"; exit 0 }
`;

        return `#!/usr/bin/env nu
def log [msg: string] {
  print $"[(date now | format date '%H:%M:%S')] ${label}: ($msg)"
}

let hash = (try { open --raw ${hashFile} | str trim } catch { "" })
if ($hash | is-empty) { log "no hash, skipping"; exit 0 }

let object = $"${prefix}($hash).tar.zst"
let gcs_url = $"gs://${bucket}/($object)"
${skipExisting}
let paths = [${pathList}] | where { |p| ($p | path exists) }
if ($paths | is-empty) { log "no paths to cache"; exit 0 }

for p in $paths { ^chmod -R u+w $p }

let max = ${maxEntries}
if $max > 0 {
  let entries = (try {
    ^gcloud storage ls -l $"gs://${bucket}/${prefix}*.tar.zst"
    | lines
    | where { |l| $l | str ends-with ".tar.zst" }
    | each { |l|
        let parts = ($l | str trim | split row -r '\\s+')
        { url: ($parts | last), created: ($parts | get 1) }
      }
    | sort-by created | reverse | skip $max
  } catch { [] })
  for e in $entries {
    ^gcloud storage rm $e.url | complete | ignore
    log $"evicted ($e.url)"
  }
}

let uncompressed = ($paths | each { |p| try { du $p | get apparent.0 | into int } catch { 0 } } | math sum)
log $"compressing (($uncompressed / 1_000_000) | math round --precision 1)MB ..."
let tmp = $"${tmpDir}/cache-($hash).tar.zst"
let t0 = (date now)
^tar cf - ...$paths | ^zstd -${compressionLevel} ${threadFlag}${forceSave ? " -f" : ""} -o $tmp
let compress_elapsed = (((date now) - $t0) | into int) / 1_000_000_000
let compressed = (ls $tmp | get size.0 | into int)
let ratio = (if $compressed > 0 { $uncompressed / $compressed | math round --precision 1 } else { 0 })
log $"compressed to (($compressed / 1_000_000) | math round --precision 1)MB ratio=($ratio)x in ($compress_elapsed)s"

log "uploading ..."
let t1 = (date now)
^gcloud storage cp $tmp $gcs_url
rm $tmp
let upload_elapsed = (((date now) - $t1) | into int) / 1_000_000_000
let speed = (if $upload_elapsed > 0 { ($compressed / 1_000_000) / $upload_elapsed | math round --precision 1 } else { 0 })
log $"uploaded ($gcs_url) in ($upload_elapsed)s ($speed) MB/s"`;
    }

    // ── Step builders (dispatch by backend) ────────────────────────

    private static _makeCacheRestoreStep(
        c: TaskCacheSpec,
        taskName?: string,
    ): TaskStepSpec {
        const script =
            c.backend?.type === "gcs"
                ? TaskDef._makeGcsRestoreScript(c, taskName)
                : TaskDef._makePvcRestoreScript(c, taskName);
        return {
            name: `restore-${c.name}-cache`,
            image: c.image ?? (c.backend?.type === "gcs" ? DEFAULT_GCS_CACHE_IMAGE : DEFAULT_BASE_IMAGE),
            script,
            ...(c.backend?.type === "gcs"
                ? { env: [{ name: "CLOUDSDK_CONFIG", value: "/tekton/home/.config/gcloud" }] }
                : {}),
            ...(c.workingDir ? { workingDir: c.workingDir } : {}),
            ...(c.computeResources
                ? { computeResources: c.computeResources }
                : {}),
        };
    }

    private static _makeCacheSaveStep(
        c: TaskCacheSpec,
        taskName?: string,
    ): TaskStepSpec {
        const script =
            c.backend?.type === "gcs"
                ? TaskDef._makeGcsSaveScript(c, taskName)
                : TaskDef._makePvcSaveScript(c, taskName);
        return {
            name: `save-${c.name}-cache`,
            image: c.image ?? (c.backend?.type === "gcs" ? DEFAULT_GCS_CACHE_IMAGE : DEFAULT_BASE_IMAGE),
            script,
            onError: "continue" as const,
            ...(c.backend?.type === "gcs"
                ? { env: [{ name: "CLOUDSDK_CONFIG", value: "/tekton/home/.config/gcloud" }] }
                : {}),
            ...(c.workingDir ? { workingDir: c.workingDir } : {}),
            ...(c.computeResources
                ? { computeResources: c.computeResources }
                : {}),
        };
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
        const restoreSteps = this.caches.map((c) =>
            TaskDef._makeCacheRestoreStep(c, this.name),
        );
        const saveSteps = this.caches
            .filter((c) => c.saveStrategy !== "finally")
            .map((c) => TaskDef._makeCacheSaveStep(c, this.name));
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
            },
        });
    }

    /**
     * Returns standalone Task objects for caches that use `saveStrategy: "finally"`.
     * These tasks are intended to be wired into the pipeline's `finally` block so
     * they run in their own pod after the build pod has terminated.
     */
    getCacheFinallyTasks(): Task[] {
        return this.caches
            .filter((c) => c.saveStrategy === "finally")
            .map((c) => {
                // GCS finally tasks use the source workspaces only (no PVC needed).
                // PVC finally tasks prepend the cache workspace so hash files survive across pods.
                const taskWorkspaces =
                    c.backend?.type === "gcs"
                        ? [...this.workspaces]
                        : [
                              c.workspace!,
                              ...this.workspaces.filter(
                                  (w) => w.name !== c.workspace!.name,
                              ),
                          ];
                return new TaskDef({
                    name: `save-${c.name}-cache-${this.name}`,
                    workspaces: taskWorkspaces,
                    steps: [TaskDef._makeCacheSaveStep(c, this.name)],
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
