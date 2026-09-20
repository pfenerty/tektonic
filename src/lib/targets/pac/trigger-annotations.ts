import { TRIGGER_EVENTS } from "../../core/trigger-events";
import { globToRegex, toList } from "../../core/trigger";
import type { PipelineTrigger, TriggerRule } from "../../core/trigger";

/** Maps a {@link TRIGGER_EVENTS} value to its PAC `on-event` / CEL `event` name. */
const PAC_EVENT: Record<TRIGGER_EVENTS, string> = {
    [TRIGGER_EVENTS.PUSH]: "push",
    [TRIGGER_EVENTS.PULL_REQUEST]: "pull_request",
    [TRIGGER_EVENTS.TAG]: "push", // tags arrive as push events; distinguished by ref
};

const PAC = "pipelinesascode.tekton.dev";

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

/** The PAC annotation prefix, for targets and tests that build annotation keys. */
export { PAC as PAC_ANNOTATION_PREFIX };
