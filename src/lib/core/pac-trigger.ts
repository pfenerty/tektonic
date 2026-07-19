import { TRIGGER_EVENTS } from "./trigger-events";

/** Maps a {@link TRIGGER_EVENTS} value to its PAC `on-event` / CEL `event` name. */
const PAC_EVENT: Record<TRIGGER_EVENTS, string> = {
    [TRIGGER_EVENTS.PUSH]: "push",
    [TRIGGER_EVENTS.PULL_REQUEST]: "pull_request",
    [TRIGGER_EVENTS.TAG]: "push", // tags arrive as push events; distinguished by ref
};

const PAC = "pipelinesascode.tekton.dev";

/**
 * One pipeline firing rule: an event scope plus branch/path filters that AND together.
 * Rules in a {@link PipelineTrigger.rules} list OR together.
 */
export interface TriggerRule {
    /** Event(s) this rule matches (required). */
    on: TRIGGER_EVENTS | TRIGGER_EVENTS[];
    /**
     * The branch the event concerns — the **pushed** branch for `push`, the **target/into**
     * branch for `pull_request` (PAC `target_branch`). Glob string or list.
     */
    branch?: string | string[];
    /**
     * PR **head/from** branch (`pull_request` only). Glob string or list. PAC exposes this only
     * in CEL, so setting it forces the `on-cel-expression` path.
     */
    sourceBranch?: string | string[];
    /** Path globs — the rule matches only if changed files match these (CEL `files.all`). */
    pathsChanged?: string[];
    /** Path globs to ignore. */
    pathsIgnored?: string[];
    /** Raw PAC CEL fragment, AND-ed with the rule's other fields. */
    cel?: string;
}

/**
 * Unified pipeline firing config, emitted as `pipelinesascode.tekton.dev/*` annotations by
 * {@link TektonicProject}. Decides whether the whole `PipelineRun` fires for an event — distinct
 * from the job-level `when`/`onChanges`/`fanOut` rules that gate individual tasks inside a run.
 */
export interface PipelineTrigger {
    /** Firing rules, OR-ed together. At least one required. */
    rules: TriggerRule[];
    /** Regex — also start the pipeline on a matching PR comment (`on-comment`). */
    comment?: string;
    /** Start the pipeline when the PR carries any of these labels (`on-label`). */
    labels?: string[];
    /** Cancel an in-progress run of this pipeline when a newer event arrives (`cancel-in-progress`). */
    cancelInProgress?: boolean;
    /** Whole-expression raw PAC CEL escape hatch (`on-cel-expression`); used instead of `rules`. */
    cel?: string;
}

/** Normalizes a single value or list to a list. */
function toList<T>(v: T | T[]): T[] {
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

/** Union of all rules' events (deduplicated) — drives PipelineRun emission, naming, tag detection. */
export function triggerEvents(t: PipelineTrigger): TRIGGER_EVENTS[] {
    return [...new Set(t.rules.flatMap((r) => toList(r.on)))];
}

/** PAC bracket-list format, e.g. `[push, pull_request]`. */
const list = (xs: string[]): string => `[${xs.join(", ")}]`;

/** Whether the trigger requires the CEL path (multiple rules, a source-branch, or raw cel). */
function needsCel(t: PipelineTrigger): boolean {
    return (
        !!t.cel ||
        t.rules.length > 1 ||
        t.rules.some((r) => r.sourceBranch !== undefined || r.cel !== undefined)
    );
}

/** Compiles one rule to a CEL boolean (its fields AND-ed). */
function ruleToCel(r: TriggerRule): string {
    const clauses: string[] = [];
    const events = toList(r.on).map((e) => PAC_EVENT[e]);
    clauses.push(
        events.length === 1
            ? `event == '${events[0]}'`
            : `event in [${events.map((e) => `'${e}'`).join(", ")}]`,
    );
    const branchClause = (field: "target_branch" | "source_branch", globs: string[]): string => {
        const parts = globs.map((g) =>
            /[*?]/.test(g) ? `${field}.matches('${globToRegex(g)}')` : `${field} == '${g}'`,
        );
        return parts.length === 1 ? parts[0] : `(${parts.join(" || ")})`;
    };
    if (r.branch !== undefined) clauses.push(branchClause("target_branch", toList(r.branch)));
    if (r.sourceBranch !== undefined) clauses.push(branchClause("source_branch", toList(r.sourceBranch)));
    if (r.pathsChanged?.length) {
        const any = r.pathsChanged
            .map((g) => `files.all.exists(f, f.matches('${globToRegex(g)}'))`)
            .join(" || ");
        clauses.push(r.pathsChanged.length === 1 ? any : `(${any})`);
    }
    if (r.pathsIgnored?.length) {
        // Match unless every changed file is ignored (i.e. only ignored paths changed).
        const ignored = r.pathsIgnored.map((g) => `f.matches('${globToRegex(g)}')`).join(" || ");
        clauses.push(`!files.all.all(f, ${ignored})`);
    }
    if (r.cel) clauses.push(`(${r.cel})`);
    return clauses.length === 1 ? clauses[0] : `(${clauses.join(" && ")})`;
}

/** Builds the PAC matching annotations for a trigger. */
export function triggerAnnotations(t: PipelineTrigger): Record<string, string> {
    const ann: Record<string, string> = {};

    if (needsCel(t)) {
        ann[`${PAC}/on-cel-expression`] = t.cel ?? t.rules.map(ruleToCel).join(" || ");
    } else {
        // Single rule, no source-branch, no raw cel → discrete annotations.
        const r = t.rules[0];
        const events = [...new Set(toList(r.on).map((e) => PAC_EVENT[e]))];
        ann[`${PAC}/on-event`] = list(events);
        const isTag = toList(r.on).includes(TRIGGER_EVENTS.TAG);
        ann[`${PAC}/on-target-branch`] = isTag
            ? "[refs/tags/*]"
            : list(r.branch !== undefined ? toList(r.branch) : ["*"]);
        if (r.pathsChanged?.length) ann[`${PAC}/on-path-changed`] = list(r.pathsChanged);
        if (r.pathsIgnored?.length) ann[`${PAC}/on-path-change-ignore`] = list(r.pathsIgnored);
    }

    if (t.comment) ann[`${PAC}/on-comment`] = t.comment;
    if (t.labels?.length) ann[`${PAC}/on-label`] = list(t.labels);
    if (t.cancelInProgress) ann[`${PAC}/cancel-in-progress`] = "true";
    return ann;
}
