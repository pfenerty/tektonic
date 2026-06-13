import type { TaskCacheSpec, TaskStepSpec } from "../core/task";
import type { BackendCtx, CacheBackend } from "../core/cache-backend";
import { threadFlag, hashExpr } from "./shared";

/**
 * PVC-based cache backend (the default when no `backend` is specified).
 *
 * Stores cache archives on a Kubernetes PersistentVolumeClaim.
 * The workspace must be declared on the task via `TaskCacheSpec.workspace`.
 */
export class PvcBackend implements CacheBackend {
    readonly type = "pvc" as const;
    readonly needsPvcWorkspace = true as const;

    restoreStep(spec: TaskCacheSpec, taskName: string, ctx: BackendCtx): TaskStepSpec {
        return {
            name: `restore-${spec.name}-cache`,
            image: spec.image ?? ctx.defaultBaseImage,
            script: this._makeRestoreScript(spec, taskName),
            ...(spec.workingDir ? { workingDir: spec.workingDir } : {}),
            ...(spec.computeResources ? { computeResources: spec.computeResources } : {}),
        };
    }

    saveStep(spec: TaskCacheSpec, taskName: string, ctx: BackendCtx): TaskStepSpec {
        return {
            name: `save-${spec.name}-cache`,
            image: spec.image ?? ctx.defaultBaseImage,
            script: this._makeSaveScript(spec, taskName),
            onError: "continue" as const,
            ...(spec.workingDir ? { workingDir: spec.workingDir } : {}),
            ...(spec.computeResources ? { computeResources: spec.computeResources } : {}),
        };
    }

    private _hashFilePath(c: TaskCacheSpec, taskName?: string): string {
        const wsPath = `$(workspaces.${c.workspace!.name}.path)`;
        if (c.saveStrategy === "finally") {
            return `${wsPath}/.cache-${c.name}-hash${taskName ? `-${taskName}` : ""}`;
        }
        return `/tekton/home/.cache-${c.name}-hash`;
    }

    private _makeRestoreScript(c: TaskCacheSpec, taskName?: string): string {
        const wsName = c.workspace!.name;
        const wsPath = `$(workspaces.${wsName}.path)`;
        const hashFile = this._hashFilePath(c, taskName);
        const flag = threadFlag(c);
        const label = `restore-${c.name}-cache`;

        if (c.compress) {
            const expr = hashExpr(c);
            return `#!/usr/bin/env nu
def log [msg: string] {
  print $"[(date now | format date '%H:%M:%S')] ${label}: ($msg)"
}

${expr}
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
  ^zstd -d ${flag} -c $archive | ^tar xf - -o --no-same-permissions
  let elapsed = (((date now) - $t0) | into int) / 1_000_000_000
  log $"restored in ($elapsed)s"
} else {
  log $"miss ($hash)"
}`;
        }
        // Uncompressed PVC restore
        const keyFiles = c.key.join(" ");
        const copyPaths = c.paths
            .map((p) => `  [ -e "$CACHE_DIR/${p}" ] && cp -r "$CACHE_DIR/${p}" "./${p}" || true`)
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

    private _makeSaveScript(c: TaskCacheSpec, taskName?: string): string {
        const wsName = c.workspace!.name;
        const wsPath = `$(workspaces.${wsName}.path)`;
        const hashFile = this._hashFilePath(c, taskName);
        const compressionLevel = c.compressionLevel ?? 1;
        const maxEntries = c.maxEntries ?? 3;
        const forceSave = c.forceSave ?? false;
        const flag = threadFlag(c);
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
^tar cf - ...$paths | ^zstd -${compressionLevel} ${flag}${forceSave ? " -f" : ""} -o $archive
let elapsed = (((date now) - $t0) | into int) / 1_000_000_000
let compressed = (ls $archive | get size.0)
let ratio = ($uncompressed / ($compressed | into int) | math round --precision 1)
log $"saved ($compressed) ratio=($ratio)x in ($elapsed)s"`;
        }
        // Uncompressed PVC save
        const copyPaths = c.paths.map((p) => `  cp -r "./${p}" "$CACHE_DIR/${p}"`).join("\n");
        const saveCondition = forceSave
            ? `echo "saving cache ($HASH)"\n  mkdir -p "$CACHE_DIR"\n${copyPaths}`
            : `if [ ! -d "$CACHE_DIR" ]; then\n  echo "saving cache ($HASH)"\n  mkdir -p "$CACHE_DIR"\n${copyPaths}\nfi`;
        return `#!/bin/sh
HASH=$(cat ${hashFile} 2>/dev/null || echo "")
[ -z "$HASH" ] && exit 0
CACHE_DIR="${wsPath}/$HASH"
${saveCondition}`;
    }
}
