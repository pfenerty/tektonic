import { Construct } from 'constructs';
import { ApiObject } from 'cdk8s';
import { TEKTON_API_V1 } from '../constants';
import { Param } from './param';
import { Workspace } from './workspace';
import { Task, TaskLike, TaskDef } from './task';
import { TRIGGER_EVENTS } from './trigger-events';

/** Options for constructing a {@link Pipeline}. */
export interface PipelineOptions {
  /**
   * Pipeline name. Auto-generated from the trigger type when omitted
   * (e.g. `"push-pipeline"` for a single push trigger).
   */
  name?: string;
  /** Trigger events that should start this pipeline (used by {@link TektonProject} to wire webhooks). */
  triggers?: TRIGGER_EVENTS[];
  /** Top-level tasks. Transitive dependencies are auto-discovered via `task.needs`. */
  tasks: TaskLike[];
  /** Tasks that run unconditionally after all regular tasks complete or fail. */
  finallyTasks?: TaskLike[];
  /** Additional pipeline-level params not tied to any specific task. */
  params?: Param[];
  /**
   * Target branch filter used by {@link PACProject} for the
   * `pipelinesascode.tekton.dev/on-target-branch` annotation.
   * Accepts a glob pattern. Defaults to `"*"` (all branches).
   * Ignored for `TRIGGER_EVENTS.TAG` pipelines, which always target `"refs/tags/*"`.
   */
  onTargetBranch?: string;
  /**
   * Overall PipelineRun timeout as a Go duration string (e.g. `"2h"`, `"90m"`).
   * Emitted by {@link PACProject} as `spec.timeouts.pipeline`. When unset, Tekton's
   * default (1h) applies — raise it for long pipelines (e.g. many image builds).
   */
  timeout?: string;
}

/**
 * A Tekton Pipeline definition.
 *
 * Automatically discovers all transitive task dependencies, infers the union of
 * params and workspaces from all tasks, validates the dependency graph, and
 * topologically sorts tasks for execution.
 */
export class Pipeline {
  readonly name: string;
  /** Trigger events associated with this pipeline. */
  readonly triggers: TRIGGER_EVENTS[];
  /** Top-level tasks provided at construction. */
  readonly tasks: TaskLike[];
  /** All tasks including transitive dependencies discovered via `task.needs`. */
  readonly allTasks: TaskLike[];
  /** Tasks that run unconditionally after all regular tasks complete or fail. */
  readonly finallyTasks: TaskLike[];
  /**
   * Target branch filter for PAC's `on-target-branch` annotation.
   * Defaults to `"*"`. Ignored for TAG pipelines, which always use `"refs/tags/*"`.
   */
  readonly onTargetBranch: string;
  /** Overall PipelineRun timeout (Go duration), emitted by PACProject. Unset = Tekton default. */
  readonly timeout?: string;
  private readonly extraParams: Param[];
  /** @internal Auto-generated task that sets all status contexts to pending at pipeline start. */
  protected readonly _pendingTask?: TaskDef;

  private static _counter = 0;

  constructor(opts: PipelineOptions) {
    if (opts.name) {
      this.name = opts.name;
    } else if (opts.triggers?.length === 1) {
      this.name = `${opts.triggers[0].replace('_', '-')}-pipeline`;
    } else {
      this.name = `pipeline-${Pipeline._counter++}`;
    }
    this.triggers = opts.triggers ?? [];
    this.tasks = opts.tasks;
    this.finallyTasks = opts.finallyTasks ?? [];
    this.onTargetBranch = opts.onTargetBranch ?? '*';
    this.timeout = opts.timeout;
    this.extraParams = opts.params ?? [];

    const regularTasks = this.discoverAllTasks(opts.tasks);
    const statusTasks = regularTasks.filter(
      (t): t is TaskDef => t instanceof TaskDef && !!t.statusContext && !!t.statusReporter,
    );

    if (statusTasks.length > 0) {
      const reporter = statusTasks[0].statusReporter!;
      const contexts = statusTasks.map(t => t.statusContext!);
      this._pendingTask = reporter.createPendingTask(contexts, `set-status-pending-${this.name}`);
      this.allTasks = [this._pendingTask, ...regularTasks];
    } else {
      this.allTasks = regularTasks;
    }

    // Collect cache-save finally tasks from TaskDef nodes only.
    const cacheFinallyTasks = regularTasks
      .filter((t): t is TaskDef => t instanceof TaskDef)
      .flatMap(t => t.getCacheFinallyTasks());
    if (cacheFinallyTasks.length > 0) {
      (this.finallyTasks as TaskLike[]).push(...cacheFinallyTasks);
    }
  }

  protected discoverAllTasks(tasks: TaskLike[]): TaskLike[] {
    const seen = new Set<TaskLike>();
    const visit = (t: TaskLike) => {
      if (seen.has(t)) return;
      seen.add(t);
      for (const dep of t.needs) visit(dep);
    };
    for (const t of tasks) visit(t);
    return [...seen];
  }

  /** Returns the de-duplicated union of all task params plus any extra pipeline-level params. */
  inferParams(): Record<string, unknown>[] {
    const seen = new Map<string, Param>();
    for (const task of [...this.allTasks, ...this.finallyTasks]) {
      // A fan-out param is supplied per-element by the task's matrix, not by a
      // pipeline-level param, so exclude it from inference.
      const matrixParam = task instanceof TaskDef && task.fanOut ? task.fanOut.as.name : undefined;
      for (const p of task.params) {
        if (p.name === matrixParam) continue;
        if (!seen.has(p.name) && !p.pipelineExpression) seen.set(p.name, p);
      }
    }
    for (const p of this.extraParams) {
      if (!seen.has(p.name)) seen.set(p.name, p);
    }
    return [...seen.values()].map(p => p.toSpec());
  }

  /** Returns the de-duplicated union of all task workspaces. */
  inferWorkspaces(): Record<string, unknown>[] {
    const seen = new Map<string, Workspace>();
    for (const task of [...this.allTasks, ...this.finallyTasks]) {
      for (const w of task.workspaces) {
        if (!seen.has(w.name)) seen.set(w.name, w);
      }
    }
    return [...seen.values()].map(w => w.toSpec());
  }

  /**
   * @internal Returns the Pipeline spec as a plain object.
   * Used by {@link TektonProject} via `_build()` and by {@link PACProject} to inline
   * the spec into a PAC PipelineRun template.
   */
  _buildSpec(
    extraParams?: Record<string, unknown>[],
    namePrefix?: string,
  ): Record<string, unknown> {
    this.validate();
    const sorted = this.topoSort();
    return {
      params: this.deduplicateParams([...(extraParams ?? []), ...this.inferParams()]),
      workspaces: this.inferWorkspaces(),
      tasks: sorted.map(task =>
        task._toPipelineTaskSpec(this.runAfterFor(task), namePrefix),
      ),
      ...(this.finallyTasks.length > 0 && {
        finally: this.finallyTasks.map(task =>
          task._toPipelineTaskSpec([], namePrefix),
        ),
      }),
    };
  }

  /** @internal Synthesizes the Pipeline resource. Called by {@link TektonProject}. */
  _build(
    scope: Construct,
    id: string,
    namespace: string,
    extraParams?: Record<string, unknown>[],
    namePrefix?: string,
  ): void {
    new ApiObject(scope, id, {
      apiVersion: TEKTON_API_V1,
      kind: 'Pipeline',
      metadata: {
        name: namePrefix ? `${namePrefix}-${this.name}` : this.name,
        namespace,
      },
      spec: this._buildSpec(extraParams, namePrefix),
    });
  }

  /**
   * Returns the `runAfter` task names for a given task within this pipeline.
   * Override in subclasses to inject additional ordering constraints.
   */
  protected runAfterFor(task: TaskLike): string[] {
    let names = task.needs
      .filter(dep => this.allTasks.includes(dep))
      .map(dep => dep.name);
    if (this._pendingTask && task instanceof TaskDef && task.statusContext && task.statusReporter && task !== this._pendingTask) {
      names = [...names, this._pendingTask.name];
    }
    return names;
  }

  private deduplicateParams(params: Record<string, unknown>[]): Record<string, unknown>[] {
    const seen = new Set<string>();
    return params.filter(p => {
      const name = p.name as string;
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  }

  private validate(): void {
    const taskSet = new Set(this.allTasks);
    const nameSet = new Set<string>();

    for (const task of this.allTasks) {
      if (nameSet.has(task.name)) {
        throw new Error(
          `Pipeline '${this.name}': duplicate task name '${task.name}'`,
        );
      }
      nameSet.add(task.name);

      for (const dep of task.needs) {
        if (!taskSet.has(dep)) {
          throw new Error(
            `Pipeline '${this.name}': task '${task.name}' depends on '${dep.name}' which is not in the pipeline`,
          );
        }
      }
    }
  }

  private topoSort(): TaskLike[] {
    const visited = new Set<TaskLike>();
    const visiting = new Set<TaskLike>();
    const result: TaskLike[] = [];

    const visit = (task: TaskLike): void => {
      if (visited.has(task)) return;
      if (visiting.has(task)) {
        throw new Error(
          `Pipeline '${this.name}': cycle detected involving task '${task.name}'`,
        );
      }
      visiting.add(task);
      for (const dep of task.needs) {
        visit(dep);
      }
      visiting.delete(task);
      visited.add(task);
      result.push(task);
    };

    for (const task of this.allTasks) visit(task);
    return result;
  }
}
