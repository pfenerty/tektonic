import type { TaskCacheSpec } from "../core/task";

/** Returns the zstd thread flag. Pass `defaultMulti=true` for backends that default to multi-threaded (e.g. GCS). */
export function threadFlag(c: TaskCacheSpec, defaultMulti = false): string {
    const multi = c.multiThreadCompression ?? defaultMulti;
    return multi ? "-T0" : "-T1";
}

/** Returns the nushell hash-computation expression for the given key files. */
export function hashExpr(c: TaskCacheSpec): string {
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
