import { createHash } from "crypto";
import { Task } from "./task";
import type { TaskLike } from "./task";
import { Result } from "./result";
import { Workspace } from "./workspace";
import { Condition, equals } from "./condition";
import type { WhenClause } from "./condition";
import { injectedImageRef } from "./injected-image";
import { sh } from "../script";

/** Default trunk branch that changes are compared against. */
export const DEFAULT_CHANGE_BASE = "main";

/** Options for {@link onChanges}. */
export interface OnChangesOptions {
    /**
     * Path globs to test for changes, e.g. `['src/**', 'package.json']`. Matched with
     * git glob pathspecs (`:(glob)`), so `**` spans directories and `*` does not.
     */
    paths: string[];
    /**
     * Name of the generated detection task. Defaults to `'detect-changes'`. Provide a
     * distinct name when a pipeline needs more than one independent change check.
     */
    name?: string;
    /**
     * Trunk branch the current commit is diffed against (`<base>...HEAD`, three-dot
     * merge-base). Defaults to `'main'`. This is what "changed" means: paths this
     * branch touched relative to the trunk. Accurate with `GitPipeline({ cloneDepth:
     * 'full' })`; on a shallow clone the merge-base is unreachable and detection fails
     * **open** (the gated job runs).
     */
    base?: string;
    /** Image providing `git`. Defaults to the project's `injectedStepImage`. */
    image?: string;
    /**
     * Repository workspace the detection task runs in. Optional under `GitPipeline`
     * (which injects the shared workspace); required for a plain `Pipeline`.
     */
    workspace?: Workspace;
}

/**
 * Runtime file-change rule (GitLab `rules:changes`).
 *
 * Creates a detection task that diffs the checked-out commit against a trunk branch
 * (`git diff --name-only <base>...HEAD`, filtered by `paths`) and writes `true`/`false`
 * to a result, then returns a {@link Condition} gating on that result. Because the
 * result is task-bound, the returned condition auto-wires the detection task into the
 * consuming task's `needs` — no manual wiring.
 *
 * Compose with branch rules through the DSL, e.g.
 * `or(onBranch('main'), onChanges(['src/**']))`.
 *
 * @example
 * ```ts
 * const deploy = new Task({
 *   name: 'deploy',
 *   when: or(onBranch('main'), onChanges(['src/**', 'package.json'])),
 *   steps: [...],
 * });
 * ```
 */
export function onChanges(paths: string[] | OnChangesOptions): Condition {
    const opts: OnChangesOptions = Array.isArray(paths) ? { paths } : paths;
    if (opts.paths.length === 0) {
        throw new Error("onChanges: at least one path is required");
    }
    return new ChangesCondition(opts, buildDetection(opts));
}

/**
 * A change rule, paired with the options it was built from so that
 * {@link Condition._unionWith} can fold an `or` of several into one detection task.
 */
class ChangesCondition extends Condition {
    constructor(
        readonly opts: OnChangesOptions,
        private readonly inner: Condition,
    ) {
        super();
    }

    compile(): WhenClause[] {
        return this.inner.compile();
    }

    sources(): TaskLike[] {
        return this.inner.sources();
    }

    /**
     * Folds `or(onChanges(a), onChanges(b))` into a single detection task over the union of
     * the paths, gated by a classic `in` guard.
     *
     * "Either of these path sets changed" is exactly "any path in their union changed", so
     * the union is the same rule with one task instead of two plus a CEL guard — and CEL
     * guards need the `enable-cel-in-whenexpression` feature flag, which is off by default.
     * Without this, gating on several path sets meant hand-maintaining a third detection
     * task whose paths had to be kept in sync with the other two.
     *
     * Only folds when every operand is a change rule agreeing on base, image and workspace:
     * those decide what the single task would have to be, and a mismatch has no single
     * answer. Anything else falls back to the CEL join.
     */
    _unionWith(others: Condition[]): Condition | undefined {
        const all = [this, ...others];
        if (!all.every((c): c is ChangesCondition => c instanceof ChangesCondition)) return undefined;
        const sameEnvironment = all.every(
            c =>
                (c.opts.base ?? DEFAULT_CHANGE_BASE) === (this.opts.base ?? DEFAULT_CHANGE_BASE) &&
                c.opts.image === this.opts.image &&
                c.opts.workspace === this.opts.workspace,
        );
        if (!sameEnvironment) return undefined;

        const paths = [...new Set(all.flatMap(c => c.opts.paths))];
        return onChanges({
            ...this.opts,
            paths,
            name: unionName(all.map(c => c.opts.name ?? DEFAULT_DETECTION_TASK_NAME)),
        });
    }
}

/** Default name of the task {@link onChanges} generates. */
const DEFAULT_DETECTION_TASK_NAME = "detect-changes";

/**
 * A stable, readable name for a union detection task: `detect-go-changes` and
 * `detect-node-changes` become `detect-go-node-changes`. Names that do not follow that shape
 * are joined as-is, and anything over the 63-character Kubernetes limit is truncated with a
 * short digest so it stays unique.
 */
function unionName(names: string[]): string {
    const parts = [...new Set(names)];
    const cores = parts.map(n => n.replace(/^detect-/, "").replace(/-changes$/, ""));
    const joined = cores.every(c => c.length > 0)
        ? `detect-${cores.join("-")}-changes`
        : parts.join("-or-");
    if (joined.length <= 63) return joined;
    const digest = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 8);
    return `${joined.slice(0, 54)}-${digest}`;
}

/** Creates the detection task for one change rule and returns the guard on its result. */
function buildDetection(opts: OnChangesOptions): Condition {
    const changed = new Result({
        name: "changed",
        description: "'true' when any of the watched paths changed vs the trunk",
    });
    const base = opts.base ?? DEFAULT_CHANGE_BASE;
    const pathspecs = opts.paths.map((p) => `':(glob)${p}'`).join(" ");

    // `-c safe.directory='*'` is passed inline rather than `git config --global` because
    // $HOME may be read-only in the pod (git-clone uses a workspace-local gitconfig).
    // Command substitution `$(...)` is deliberately avoided (it collides with Tekton's own
    // `$(...)` interpolation); a temp file + `[ -s ]` is used instead. Three-dot
    // `FETCH_HEAD...HEAD` diffs from the merge-base (what this branch changed vs trunk).
    // Fails **open** (treats as changed) when the trunk is unfetchable or the merge-base
    // is unreachable (shallow clone) — so the gated job runs rather than being wrongly skipped.
    const git = "git -c safe.directory='*'";
    const script = sh`
        if ${git} fetch --no-tags origin "${base}" 2>/dev/null; then
          if ${git} diff --name-only FETCH_HEAD...HEAD -- ${pathspecs} > /tmp/tektonic-changed.txt 2>/dev/null; then
            if [ -s /tmp/tektonic-changed.txt ]; then
              printf true > ${changed.path}
            else
              printf false > ${changed.path}
            fi
          else
            printf true > ${changed.path}
          fi
        else
          printf true > ${changed.path}
        fi`;

    new Task({
        name: opts.name ?? DEFAULT_DETECTION_TASK_NAME,
        results: [changed],
        workspaces: opts.workspace ? [opts.workspace] : [],
        steps: [
            {
                name: "detect",
                image: opts.image ?? injectedImageRef("sh", "git"),
                script,
            },
        ],
    });

    // changed is now bound to the detection task; equals() captures it as a source
    // so the consuming task auto-gains the detection task in `needs`.
    return equals(changed, "true");
}
