import { Param } from "./param";
import { Workspace } from "./workspace";
import { Task, TaskLike } from "./task";
import { Pipeline, PipelineOptions } from "./pipeline";
import { DEFAULT_BASE_IMAGE } from "../constants";

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

        const cloneTask = new Task({
            name: "git-clone",
            params: [url, revision],
            workspaces: [workspace],
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
                    script: `#!/usr/bin/env nu
# Mark workspace as safe before any git operations that check directory ownership.
# The workspace dir may be owned by root (local-path provisioner) while the pod
# runs as a non-root uid; git 2.35.2+ rejects such repos without this config.
git config --global --add safe.directory ${workspace.path}
git init -b main .
git remote add origin ${url}
# Fetch only the target branch at depth=1. GitHub doesn't allow fetching by arbitrary
# SHA, but the revision is always a branch tip in CI (push/PR events). Fetching a
# single branch avoids wildcard-refspec pack issues in newer git versions.
git fetch --depth=1 origin ${revision}
git checkout -b ${revision} FETCH_HEAD

# Capture git metadata for downstream tasks
let sha = (git rev-parse HEAD | str trim)
let short_sha = (git rev-parse --short HEAD | str trim)
let commit_message = (git log -1 --format=%s | str trim)
let author_name = (git log -1 --format=%an | str trim)
let author_email = (git log -1 --format=%ae | str trim)
let timestamp = (git log -1 --format=%aI | str trim)

{
    sha: $sha,
    short_sha: $short_sha,
    branch: "${revision}",
    commit_message: $commit_message,
    author_name: $author_name,
    author_email: $author_email,
    timestamp: $timestamp,
    remote_url: "${url}",
} | to json | save ${workspace.path}/git-metadata.json`,
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
            if (!(task as any).stepTemplate?.workingDir) {
                (task as any).stepTemplate = {
                    workingDir: workspace.path,
                    ...(task as any).stepTemplate,
                };
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
