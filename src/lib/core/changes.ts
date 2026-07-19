import { Task } from "./task";
import { Result } from "./result";
import { Workspace } from "./workspace";
import { Condition, equals } from "./condition";
import { DEFAULT_BASE_IMAGE } from "../constants";
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
    /** Image providing `git`. Defaults to {@link DEFAULT_BASE_IMAGE}. */
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
        name: opts.name ?? "detect-changes",
        results: [changed],
        workspaces: opts.workspace ? [opts.workspace] : [],
        steps: [
            {
                name: "detect",
                image: opts.image ?? DEFAULT_BASE_IMAGE,
                script,
            },
        ],
    });

    // changed is now bound to the detection task; equals() captures it as a source
    // so the consuming task auto-gains the detection task in `needs`.
    return equals(changed, "true");
}
