import { TRIGGER_EVENTS } from "./trigger-events";

/**
 * One pipeline firing rule: an event scope plus branch/path filters that AND together.
 * Rules in a {@link PipelineTrigger.rules} list OR together.
 */
export interface TriggerRule {
    /** Event(s) this rule matches (required). */
    on: TRIGGER_EVENTS | TRIGGER_EVENTS[];
    /**
     * The branch the event concerns — the **pushed** branch for `push`, the **target/into**
     * branch for `pull_request`. Glob string or list.
     */
    branch?: string | string[];
    /**
     * PR **head/from** branch (`pull_request` only). Glob string or list. Providers usually
     * expose this only in a CEL expression, so setting it forces the expression path.
     */
    sourceBranch?: string | string[];
    /** Path globs — the rule matches only if changed files match these. */
    pathsChanged?: string[];
    /** Path globs to ignore. */
    pathsIgnored?: string[];
    /** Raw CEL fragment, AND-ed with the rule's other fields. */
    cel?: string;
}

/**
 * Unified pipeline firing config: whether the whole run fires for an event — distinct from
 * the job-level `when`/`onChanges`/`fanOut` rules that gate individual tasks inside a run.
 *
 * It is provider-neutral: the {@link SynthTarget} that delivers the pipeline compiles it to
 * whatever its runner matches on (the PAC target emits matching annotations).
 */
export interface PipelineTrigger {
    /** Firing rules, OR-ed together. At least one required. */
    rules: TriggerRule[];
    /** Regex — also start the pipeline on a matching PR comment. */
    comment?: string;
    /** Start the pipeline when the PR carries any of these labels. */
    labels?: string[];
    /** Cancel an in-progress run of this pipeline when a newer event arrives. */
    cancelInProgress?: boolean;
    /** Whole-expression raw CEL escape hatch; used instead of `rules`. */
    cel?: string;
}

/** Normalizes a single value or list to a list. */
export function toList<T>(v: T | T[]): T[] {
    return Array.isArray(v) ? v : [v];
}

/**
 * Converts a shell-style glob to an anchored RE2 regex for CEL `.matches()`:
 * `**` → `.*`, `*` → `[^/]*`, `?` → `[^/]`, other regex metachars escaped.
 */
export function globToRegex(glob: string): string {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*") {
            if (glob[i + 1] === "*") {
                re += ".*";
                i++;
            } else {
                re += "[^/]*";
            }
        } else if (c === "?") {
            re += "[^/]";
        } else if (".+^${}()|[]\\".includes(c)) {
            re += "\\" + c;
        } else {
            re += c;
        }
    }
    return `^${re}$`;
}

/** Union of all rules' events (deduplicated) — drives run emission, naming, tag detection. */
export function triggerEvents(t: PipelineTrigger): TRIGGER_EVENTS[] {
    return [...new Set(t.rules.flatMap((r) => toList(r.on)))];
}
