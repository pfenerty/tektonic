import type { WhenExpression } from "./pipeline-task";
import type { TaskLike } from "./task";
import { Result } from "./result";

/**
 * Anything that renders to a Tekton interpolation expression string.
 *
 * `Param`, `Result`, and `Workspace` all satisfy this via their `toString()`,
 * so they can be passed directly to condition constructors instead of
 * hand-written `$(...)` strings.
 */
export type Expressable = string | { toString(): string };

/** If `handle` is a task-bound {@link Result}, returns its producing task for auto-wiring. */
function sourceOf(handle: Expressable): TaskLike | undefined {
    return handle instanceof Result ? handle.owner : undefined;
}

/**
 * A CEL-based `when` guard. Emitted as `{ cel: "<expr>" }` on a pipeline task.
 *
 * CEL guards are valid in the Tekton `v1.WhenExpression` schema but require the
 * cluster's `enable-cel-in-whenexpression` feature flag at runtime. They are the
 * only way to express pattern matching (`matches`), OR across distinct inputs,
 * and negation of compound conditions — classic `in`/`notin` guards cannot.
 */
export interface CelWhenExpression {
    cel: string;
}

/** A single Tekton `when` clause: either a classic guard or a CEL guard. */
export type WhenClause = WhenExpression | CelWhenExpression;

/**
 * A composable, typed pipeline rule that compiles to one or more Tekton `when`
 * clauses.
 *
 * Conditions are plain values: name them, reuse them across tasks, and unit-test
 * them. Pass one to a task's `when` attribute (or to {@link gated}). Tekton `when`
 * is an implicit AND of its clauses, so {@link Condition.and} simply concatenates.
 *
 * @example
 * ```ts
 * const test = new Task({ name: 'test', when: onBranchMatching('^(main|release/.*)$'), steps: [...] });
 * const deploy = new Task({ name: 'deploy', when: onBranch('main').and(equals(route, 'go')), steps: [...] });
 * ```
 */
export abstract class Condition {
    /** Compiles this condition to Tekton `when` clauses. */
    abstract compile(): WhenClause[];

    /**
     * Tasks whose results this condition references. A `Task` using this condition
     * as its `when` auto-adds these to `needs`, so gating on a task's result (e.g.
     * a change-detection or decision task) wires the dependency edge with no manual
     * `needs`. Defaults to none.
     */
    sources(): TaskLike[] {
        return [];
    }

    /** Combines this condition with others via logical AND (concatenated `when` clauses). */
    and(...others: Condition[]): Condition {
        return new AndCondition([this, ...others]);
    }
}

/** De-duplicates a list of task nodes preserving order. */
function dedupeSources(tasks: TaskLike[]): TaskLike[] {
    return [...new Set(tasks)];
}

/** A single classic `in`/`notin` guard. */
class CmpCondition extends Condition {
    constructor(
        private readonly input: string,
        private readonly operator: "in" | "notin",
        private readonly values: string[],
        private readonly _sources: TaskLike[] = [],
    ) {
        super();
    }
    compile(): WhenClause[] {
        return [{ input: this.input, operator: this.operator, values: this.values }];
    }
    sources(): TaskLike[] {
        return this._sources;
    }
}

/** A single CEL guard. */
class CelCondition extends Condition {
    constructor(
        private readonly expr: string,
        private readonly _sources: TaskLike[] = [],
    ) {
        super();
    }
    compile(): WhenClause[] {
        return [{ cel: this.expr }];
    }
    sources(): TaskLike[] {
        return this._sources;
    }
}

/** Logical AND — Tekton evaluates all `when` clauses as a conjunction. */
class AndCondition extends Condition {
    constructor(private readonly parts: Condition[]) {
        super();
    }
    compile(): WhenClause[] {
        return this.parts.flatMap((p) => p.compile());
    }
    sources(): TaskLike[] {
        return dedupeSources(this.parts.flatMap((p) => p.sources()));
    }
}

/** True when `input` equals `value`. Classic guard — no feature flag required. */
export const equals = (input: Expressable, value: string): Condition =>
    new CmpCondition(String(input), "in", [value], sourceList(input));

/** True when `input` does not equal `value`. Classic guard — no feature flag required. */
export const notEquals = (input: Expressable, value: string): Condition =>
    new CmpCondition(String(input), "notin", [value], sourceList(input));

/** True when `input` is one of `values`. Classic guard — no feature flag required. */
export const isIn = (input: Expressable, values: string[]): Condition =>
    new CmpCondition(String(input), "in", values, sourceList(input));

/** True when `input` is not any of `values`. Classic guard — no feature flag required. */
export const notIn = (input: Expressable, values: string[]): Condition =>
    new CmpCondition(String(input), "notin", values, sourceList(input));

/**
 * True when `input` matches the RE2 regular expression `pattern`.
 *
 * Compiles to a CEL guard `'<input>'.matches('<pattern>')` — the input value is
 * quoted so that after Tekton substitutes the `$(...)` expression the result is a
 * CEL string literal. Requires the `enable-cel-in-whenexpression` feature flag.
 *
 * Note: single quotes in `pattern` are not escaped; keep patterns quote-free.
 */
export const matches = (input: Expressable, pattern: string): Condition =>
    new CelCondition(`'${input}'.matches('${pattern}')`, sourceList(input));

/** Returns `[owner]` when `handle` is a task-bound Result, else `[]`. */
function sourceList(handle: Expressable): TaskLike[] {
    const s = sourceOf(handle);
    return s ? [s] : [];
}

/** Logical AND of the given conditions (concatenated `when` clauses). */
export const and = (...conditions: Condition[]): Condition => new AndCondition(conditions);

/**
 * Logical OR of the given conditions.
 *
 * Classic Tekton `when` cannot OR across distinct inputs, so `or` compiles every
 * branch to a CEL comparison and joins them with `||` into a single CEL guard.
 * Requires the `enable-cel-in-whenexpression` feature flag. For a portable
 * alternative, compute the boolean in a task and gate on its result.
 */
export const or = (...conditions: Condition[]): Condition => {
    const toCel = (clause: WhenClause): string => {
        if ("cel" in clause) return `(${clause.cel})`;
        const list = clause.values.map((v) => `'${v}'`).join(", ");
        const member = `('${clause.input}' in [${list}])`;
        return clause.operator === "in" ? member : `!${member}`;
    };
    const expr = conditions
        .map((c) => c.compile().map(toCel).join(" && "))
        .map((branch) => `(${branch})`)
        .join(" || ");
    const sources = dedupeSources(conditions.flatMap((c) => c.sources()));
    return new CelCondition(expr, sources);
};

/**
 * Logical negation.
 *
 * A single classic `in`/`notin` guard is negated by flipping the operator, so it
 * stays a classic guard (no feature flag). Any compound or CEL condition is
 * negated as a CEL guard `!(...)`, which requires the
 * `enable-cel-in-whenexpression` feature flag.
 */
export const not = (condition: Condition): Condition => {
    const clauses = condition.compile();
    const sources = condition.sources();
    if (clauses.length === 1 && !("cel" in clauses[0])) {
        const e = clauses[0];
        return new CmpCondition(e.input, e.operator === "in" ? "notin" : "in", e.values, sources);
    }
    const toCel = (clause: WhenClause): string => {
        if ("cel" in clause) return clause.cel;
        const list = clause.values.map((v) => `'${v}'`).join(", ");
        const member = `('${clause.input}' in [${list}])`;
        return clause.operator === "in" ? member : `!${member}`;
    };
    return new CelCondition(`!(${clauses.map(toCel).join(" && ")})`, sources);
};

/** Coerces a `when` attribute (a {@link Condition} or raw clauses) to `when` clauses. */
export const normalizeWhen = (when: Condition | WhenClause[]): WhenClause[] =>
    when instanceof Condition ? when.compile() : when;

/**
 * Well-known reference to the normalized branch name (e.g. `main`) for the current
 * pipeline run. Both synthesizers plumb this as the `source-branch` pipeline param —
 * `TektonProject` via the trigger bindings (stripping `refs/heads/` on push) and
 * `PACProject` via `{{ source_branch }}`. Branch rules reference it at authoring time
 * without a pipeline handle.
 */
export const GIT_BRANCH_REF = "$(params.source-branch)";

/** True only on the given branch. Classic guard — no feature flag required. */
export const onBranch = (name: string): Condition => equals(GIT_BRANCH_REF, name);

/** True on any of the given branches. Classic guard — no feature flag required. */
export const onBranches = (names: string[]): Condition => isIn(GIT_BRANCH_REF, names);

/**
 * True on branches matching the RE2 pattern (e.g. `'release/.*'`). Compiles to a
 * CEL guard — requires the `enable-cel-in-whenexpression` feature flag.
 */
export const onBranchMatching = (pattern: string): Condition => matches(GIT_BRANCH_REF, pattern);
