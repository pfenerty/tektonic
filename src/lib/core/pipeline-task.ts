import type { TaskLike } from './task';
import { Condition, normalizeWhen } from './condition';
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
   * Fan the task out into one TaskRun per element of an array param via a Tekton
   * `matrix`. Overrides the task's own `fanOut` attribute for this pipeline edge.
   * The matrixed param names are removed from the regular params in the emitted spec.
   */
  matrix?: MatrixSpec;
}

/** A {@link TaskLike} node that carries per-pipeline-edge overrides applied at synthesis time. */
export interface PipelineTaskNode extends TaskLike {
  readonly _overrides: PipelineTaskOverrides;
}

/**
 * Wraps a task with per-pipeline-edge overrides (e.g. `when` conditions).
 *
 * The same task can appear conditionally in one pipeline and unconditionally in
 * another by passing different `gated()` wrappers to each. Overrides are only
 * applied to the pipeline task spec — the underlying Task manifest is unchanged.
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
export function gated(task: TaskLike, overrides: PipelineTaskOverrides): PipelineTaskNode {
  return new Proxy(task as PipelineTaskNode, {
    get(target, prop) {
      if (prop === '_overrides') return overrides;
      if (prop === '_toPipelineTaskSpec') {
        return (runAfter: string[], prefix?: string) => {
          const base = target._toPipelineTaskSpec(runAfter, prefix);
          if (overrides.when) {
            const when = normalizeWhen(overrides.when);
            if (when.length) base.when = when;
          }
          if (overrides.retries !== undefined) base.retries = overrides.retries;
          if (overrides.timeout !== undefined) base.timeout = overrides.timeout;
          if (overrides.matrix) {
            const names = new Set(overrides.matrix.params.map(p => p.name));
            if (Array.isArray(base.params)) {
              base.params = (base.params as { name: string }[]).filter(p => !names.has(p.name));
              if ((base.params as unknown[]).length === 0) delete base.params;
            }
            base.matrix = overrides.matrix;
          }
          return base;
        };
      }
      return Reflect.get(target, prop);
    },
  });
}
