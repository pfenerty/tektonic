import { Param } from "./param";
import { Workspace } from "./workspace";
import { Task, TaskLike } from "./task";
import { Result } from "./result";
import { Pipeline, PipelineOptions } from "./pipeline";
import { DEFAULT_BASE_IMAGE } from "../constants";
import { sh } from "../script";

/** Options for constructing a {@link GitPipeline}. */
export interface GitPipelineOptions extends PipelineOptions {
    /**
     * Shared workspace mounted by all tasks. Auto-created when omitted.
     * Defaults to `new Workspace({ name: "workspace" })`.
     */
    workspace?: Workspace;
    /**
     * Container image used for the git clone step.
     * Defaults to `ghcr.io/pfenerty/apko-cicd/base:stable`.
     */
    cloneImage?: string;
    /**
     * Clone depth passed to `git fetch`. When `'full'` or `0`, the `--depth` flag is
     * omitted entirely, fetching full history. When a positive number, uses `--depth=N`.
     * Defaults to `1` (shallow clone) when omitted.
     *
     * Set to `'full'` when downstream steps need tag history — for example, git-cliff
     * requires all tags reachable from the target commit to generate a complete changelog.
     */
    cloneDepth?: number | 'full';
    /**
     * Emit Tekton Chains source-material results (`CHAINS-GIT_URL` / `CHAINS-GIT_COMMIT`)
     * on the git-clone task, so Chains records the fetched source in build provenance.
     * The results carry the same remote URL and full commit SHA the clone already computes
     * and are inert when Chains is not installed. Defaults to `true`.
     */
    chainsProvenance?: boolean;
}

/**
 * A Pipeline that automatically clones a git repository before running tasks.
 *
 * `GitPipeline` creates a `git-clone` task and a shared workspace, then wires
 * both into every task in the pipeline:
 * - The workspace is added to each task's `workspaces` (if not already present).
 * - `workingDir: $(workspaces.<name>.path)` is injected into each task's `stepTemplate`
 *   so steps run in the cloned repo root by default. Individual steps can override it.
 * - Tasks with no `runAfter` dependencies get `git-clone` injected automatically
 *   at pipeline-spec time — `task.needs` is never mutated, so task instances can
 *   be safely shared between multiple pipelines.
 *
 * @example
 * ```ts
 * const workspace = new Workspace({ name: "workspace" });
 * const testTask = new Task({ name: "test", steps: [...] });
 * const buildTask = new Task({ name: "build", needs: [testTask], steps: [...] });
 *
 * const pipeline = new GitPipeline({
 *   workspace,
 *   triggers: [TRIGGER_EVENTS.PUSH],
 *   tasks: [testTask, buildTask],
 * });
 * // Execution order: git-clone → test → build
 * // pipeline.workspace — the shared workspace
 * // pipeline.cloneTask — the auto-generated git-clone task
 * ```
 */
export class GitPipeline extends Pipeline {
    /** The shared workspace mounted by all tasks. */
    readonly workspace: Workspace;
    /** The auto-generated git-clone task. */
    readonly cloneTask: Task;

    constructor(opts: GitPipelineOptions) {
        const workspace =
            opts.workspace ?? new Workspace({ name: "workspace" });
        const url = new Param({ name: "url" });
        const revision = new Param({ name: "revision" });

        const commitResult      = new Result({ name: "commit",         description: "Full commit SHA" });
        const shortShaResult    = new Result({ name: "short-sha",      description: "Abbreviated commit SHA" });
        const branchResult      = new Result({ name: "branch",         description: "Checked-out branch/revision" });
        const commitMsgResult   = new Result({ name: "commit-message", description: "Commit subject line" });
        const authorNameResult  = new Result({ name: "author-name",    description: "Commit author name" });
        const authorEmailResult = new Result({ name: "author-email",   description: "Commit author email" });
        const timestampResult   = new Result({ name: "timestamp",      description: "Author timestamp (ISO 8601)" });
        const remoteUrlResult   = new Result({ name: "remote-url",     description: "Repository remote URL" });

        // Tekton Chains reads results named CHAINS-GIT_URL / CHAINS-GIT_COMMIT to record the
        // fetched source as provenance materials. Emitted by default and inert when Chains is
        // not installed; disable with `chainsProvenance: false`.
        const chainsEnabled = opts.chainsProvenance ?? true;
        const chainsGitUrl    = new Result({ name: "CHAINS-GIT_URL",    description: "Repository URL fetched (Tekton Chains provenance material)" });
        const chainsGitCommit = new Result({ name: "CHAINS-GIT_COMMIT", description: "Commit SHA fetched (Tekton Chains provenance material)" });
        const cloneResults = [
            commitResult, shortShaResult, branchResult, commitMsgResult,
            authorNameResult, authorEmailResult, timestampResult, remoteUrlResult,
            ...(chainsEnabled ? [chainsGitUrl, chainsGitCommit] : []),
        ];

        const depth = opts.cloneDepth;
        const depthArg = (depth === 'full' || depth === 0) ? '' : ` --depth=${depth ?? 1}`;
        // Chains source-material writes (full SHA + remote URL) appended to the clone script.
        // 24-space indentation matches the surrounding body so the sh-tag dedent strips uniformly.
        const chainsGitWrites = chainsEnabled
            ? `\n                        git rev-parse HEAD | tr -d '\\n' > ${chainsGitCommit.path}\n                        printf '%s' "${url}" > ${chainsGitUrl.path}`
            : "";

        const cloneTask = new Task({
            name: "git-clone",
            params: [url, revision],
            workspaces: [workspace],
            results: cloneResults,
            steps: [
                {
                    name: "clone",
                    image: opts.cloneImage ?? DEFAULT_BASE_IMAGE,
                    workingDir: workspace.path,
                    env: [
                        {
                            name: "GIT_CONFIG_GLOBAL",
                            value: `${workspace.path}/.gitconfig`,
                        },
                    ],
                    // Portable POSIX sh — the git-clone step mandates no nushell, only
                    // `git` and a `/bin/sh`. Git output is piped through `tr -d '\\n'`
                    // to strip the trailing newline (matching the previous nushell
                    // `str trim`); shell `$(...)` command substitution is deliberately
                    // avoided so it can't collide with Tekton's own `$(...)` variables.
                    script: sh`
                        set -e
                        # Mark workspace as safe before any git operations that check directory ownership.
                        # The workspace dir may be owned by root (local-path provisioner) while the pod
                        # runs as a non-root uid; git 2.35.2+ rejects such repos without this config.
                        git config --global --add safe.directory ${workspace.path}
                        git init -b main .
                        git remote add origin ${url}
                        # Fetch only the target branch. GitHub doesn't allow fetching by arbitrary SHA,
                        # but the revision is always a branch tip in CI (push/PR events). Fetching a
                        # single branch avoids wildcard-refspec pack issues in newer git versions.
                        git fetch${depthArg} origin ${revision}
                        git checkout -b ${revision} FETCH_HEAD

                        # Write git metadata as Tekton results for downstream tasks.
                        git rev-parse HEAD          | tr -d '\\n' > ${commitResult.path}
                        git rev-parse --short HEAD  | tr -d '\\n' > ${shortShaResult.path}
                        git log -1 --format=%s      | tr -d '\\n' > ${commitMsgResult.path}
                        git log -1 --format=%an     | tr -d '\\n' > ${authorNameResult.path}
                        git log -1 --format=%ae     | tr -d '\\n' > ${authorEmailResult.path}
                        git log -1 --format=%aI     | tr -d '\\n' > ${timestampResult.path}
                        printf '%s' "${revision}" > ${branchResult.path}
                        printf '%s' "${url}" > ${remoteUrlResult.path}${chainsGitWrites}`,
                },
            ],
        });

        // Discover all user tasks transitively and inject the shared workspace and default
        // workingDir. Both mutations are idempotent and safe when the same task instance
        // appears in multiple GitPipelines. Non-synthesizable TaskLikes declare their own
        // workspaces and must not be mutated here.
        const allUserTasks = GitPipeline._discoverUserTasks(opts.tasks);
        for (const task of allUserTasks) {
            if (!task.synthesizable) continue;
            if (!task.workspaces.some((w) => w.name === workspace.name)) {
                (task.workspaces as Workspace[]).push(workspace);
            }
            // Inject workspace path as the default workingDir via stepTemplate so task steps
            // don't need to set it explicitly. User-provided stepTemplate.workingDir wins.
            const t = task as { stepTemplate?: Record<string, unknown> };
            if (!t.stepTemplate?.workingDir) {
                t.stepTemplate = { workingDir: workspace.path, ...t.stepTemplate };
            }
        }

        // Pass cloneTask as the first task so Pipeline.discoverAllTasks includes it
        // in allTasks and synthesizes it into the pipeline spec.
        super({ ...opts, tasks: [cloneTask, ...opts.tasks] });

        this.workspace = workspace;
        this.cloneTask = cloneTask;
    }

    /**
     * Injects `git-clone` as a `runAfter` dependency for tasks that have no other
     * ordering constraints (i.e. root tasks). This runs at pipeline-spec time and
     * does not mutate any task's `needs` array.
     */
    protected override runAfterFor(task: TaskLike): string[] {
        const names = super.runAfterFor(task);
        if (names.length === 0 && task !== this.cloneTask) {
            return [this.cloneTask.name];
        }
        return names;
    }

    private static _discoverUserTasks(tasks: TaskLike[]): TaskLike[] {
        const seen = new Set<TaskLike>();
        const visit = (t: TaskLike): void => {
            if (seen.has(t)) return;
            seen.add(t);
            for (const dep of t.needs) visit(dep);
        };
        for (const t of tasks) visit(t);
        return [...seen];
    }
}
