import { Task } from "./task";
import { Param } from "./param";
import { Result } from "./result";
import { Workspace } from "./workspace";
import { Condition, equals } from "./condition";
import { DEFAULT_BASE_IMAGE } from "../constants";
import { sh } from "../script";

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
     * Tekton expression for the base to diff against. Defaults to `$(params.diff-base)`,
     * which the triggers supply per event (push: previous commit; PR: target). Override
     * to diff against a fixed branch/ref/SHA.
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
 * Creates a detection task that diffs the checked-out commit against a base
 * (`git diff --name-only <base> HEAD`, filtered by `paths`) and writes `true`/`false`
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

    const diffBase = new Param({ name: "diff-base" });
    const changed = new Result({
        name: "changed",
        description: "'true' when any of the watched paths changed vs the diff base",
    });
    const base = opts.base ?? `${diffBase}`;
    const pathspecs = opts.paths.map((p) => `':(glob)${p}'`).join(" ");

    // `-c safe.directory='*'` is passed inline rather than `git config --global` because
    // $HOME may be read-only in the pod (git-clone uses a workspace-local gitconfig).
    // Command substitution `$(...)` is deliberately avoided (it collides with Tekton's own
    // `$(...)` interpolation); a temp file + `[ -s ]` is used instead. Fails open (treats as
    // changed) when the base is unavailable, e.g. a brand-new branch.
    const git = "git -c safe.directory='*'";
    const script = sh`
        if ${git} fetch --no-tags --depth=1 origin "${base}" 2>/dev/null || ${git} fetch --no-tags origin "${base}" 2>/dev/null; then
          ${git} diff --name-only FETCH_HEAD HEAD -- ${pathspecs} > /tmp/tektonic-changed.txt || true
          if [ -s /tmp/tektonic-changed.txt ]; then
            printf true > ${changed.path}
          else
            printf false > ${changed.path}
          fi
        else
          printf true > ${changed.path}
        fi`;

    new Task({
        name: opts.name ?? "detect-changes",
        params: [diffBase],
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
