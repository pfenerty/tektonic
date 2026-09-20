import type { TaskLike } from './task';
import type { Param } from './param';
import type { Workspace } from './workspace';
import { normalizeWhen } from './condition';
import type { Condition } from './condition';
import type { WhenClause } from './condition';

/** A conditional expression controlling whether a pipeline task runs. */
export interface WhenExpression {
  /** The pipeline parameter or expression to evaluate (e.g. `"$(params.event-type)"`). */
  input: string;
  /** Comparison operator. */
  operator: 'in' | 'notin';
  /** Values to compare against. The task runs when `input` is (or is not) in this list. */
  values: string[];
}

/** Declares a Tekton `matrix` that fans a pipeline task out over array-typed params. */
export interface MatrixSpec {
  /** Array-typed params, each supplying one axis of the fan-out. */
  params: { name: string; value: string }[];
}

/** Per-pipeline-edge overrides applied when a task participates in a pipeline via {@link gated}. */
export interface PipelineTaskOverrides {
  /**
   * Conditional guard — the task only runs if it evaluates to true. Accepts a typed
   * {@link Condition} or raw `when` clauses. Overrides the task's own `when` attribute
   * for this pipeline edge.
   */
  when?: Condition | WhenClause[];
  /**
   * Number of times to retry the TaskRun on failure. Corresponds to `v1.PipelineTask.retries`.
   * Useful for flaky tasks (e.g. network-dependent steps) that should be retried automatically.
   */
  retries?: number;
  /**
   * Maximum duration before this task's TaskRun times out. Uses Go duration syntax
   * (e.g. `"10m"`, `"1h30m"`). Corresponds to `v1.PipelineTask.timeout`.
   */
  timeout?: string;
  /**
   * Extra ordering edges for this pipeline appearance only: the task runs after each of
   * these, exactly as if they were in its `needs`. Used by the scheduling primitives
   * ({@link serial}, {@link withConcurrency}) to chain tasks per pipeline without mutating
   * a `needs` array that other pipelines share.
   */
  after?: TaskLike[];
  /**
   * Fan the task out into one TaskRun per element of an array param via a Tekton
   * `matrix`. Overrides the task's own `fanOut` attribute for this pipeline edge.
   * The matrixed param names are removed from the regular params in the emitted spec.
   */
  matrix?: MatrixSpec;
}

/**
 * A {@link TaskLike} node that carries per-pipeline-edge overrides applied at synthesis time.
 * Implemented by {@link GatedTask}.
 */
export interface PipelineTaskNode extends TaskLike {
  readonly _overrides: PipelineTaskOverrides;
}

/**
 * @internal Applies per-edge overrides onto an already-built pipeline task spec.
 * Shared by {@link GatedTask._toPipelineTaskSpec} and `Pipeline._buildSpec`, which
 * applies overrides itself because it emits specs from the unwrapped task.
 */
export function applyOverrides(
  spec: Record<string, unknown>,
  overrides: PipelineTaskOverrides,
): Record<string, unknown> {
  if (overrides.when) {
    const when = normalizeWhen(overrides.when);
    if (when.length) spec.when = when;
    else delete spec.when;
  }
  if (overrides.retries !== undefined) spec.retries = overrides.retries;
  if (overrides.timeout !== undefined) spec.timeout = overrides.timeout;
  if (overrides.matrix) {
    const names = new Set(overrides.matrix.params.map(p => p.name));
    if (Array.isArray(spec.params)) {
      spec.params = (spec.params as { name: string }[]).filter(p => !names.has(p.name));
      if ((spec.params as unknown[]).length === 0) delete spec.params;
    }
    spec.matrix = overrides.matrix;
  }
  return spec;
}

/**
 * A gating marker produced by {@link gated}: the wrapped task plus the overrides that
 * apply to it on this pipeline edge.
 *
 * It delegates every {@link TaskLike} member to the wrapped task, but is a *distinct*
 * object from it. A `Pipeline` therefore unwraps markers with {@link unwrapGated} before
 * graph discovery, so a task that is both gated in `tasks` and depended on via another
 * task's `needs` dedupes to a single node — the reason this is a plain wrapper and not
 * a `Proxy`, which is indistinguishable from its target at the call site but not by
 * identity, and so produced duplicate task names and dropped `runAfter` edges.
 */
export class GatedTask implements PipelineTaskNode {
  constructor(
    /** The wrapped task this marker gates. */
    readonly task: TaskLike,
    /** Overrides applied to the wrapped task on this pipeline edge. */
    readonly _overrides: PipelineTaskOverrides,
  ) {}

  get name(): string { return this.task.name; }
  get synthesizable(): boolean { return this.task.synthesizable; }
  get needs(): TaskLike[] { return this.task.needs; }
  get params(): Param[] { return this.task.params; }
  get workspaces(): Workspace[] { return this.task.workspaces; }

  /** @internal Emits the wrapped task's spec with this marker's overrides applied. */
  _toPipelineTaskSpec(runAfterNames: string[], namePrefix?: string): Record<string, unknown> {
    return applyOverrides(this.task._toPipelineTaskSpec(runAfterNames, namePrefix), this._overrides);
  }
}

/** Returns the task a {@link GatedTask} wraps, or `task` itself when it is not gated. */
export function unwrapGated(task: TaskLike): TaskLike {
  return task instanceof GatedTask ? task.task : task;
}

/**
 * Wraps a task with per-pipeline-edge overrides (e.g. `when` conditions).
 *
 * The same task can appear conditionally in one pipeline and unconditionally in
 * another by passing different `gated()` wrappers to each. Overrides are only
 * applied to the pipeline task spec — the underlying Task manifest is unchanged.
 *
 * Task identity is preserved: gating a task that other tasks depend on emits a
 * single pipeline entry carrying the overrides, with all `runAfter` edges intact.
 *
 * @example
 * ```ts
 * const pipeline = new Pipeline({
 *   tasks: [
 *     clone,
 *     // Only runs on push; retried up to 2 times; times out after 20 minutes.
 *     gated(build, {
 *       when: [{ input: '$(params.type)', operator: 'in', values: ['push'] }],
 *       retries: 2,
 *       timeout: '20m',
 *     }),
 *   ],
 * });
 * ```
 */
export function gated(task: TaskLike, overrides: PipelineTaskOverrides): GatedTask {
  return new GatedTask(task, overrides);
}
