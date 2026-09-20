import type { TaskLike } from './task';
import { GatedTask, gated, unwrapGated } from './pipeline-task';

/**
 * Chains `tasks` so at most `max` of them can run at once, and returns the chained list to
 * pass to a pipeline's `tasks`.
 *
 * Tekton runs everything the DAG allows in parallel, which is the right default until the
 * cluster cannot take it: a dozen image builds submitted at once on a single worker leave
 * pods `Pending` with `Insufficient cpu` and finish no sooner than they would in sequence.
 * Fitting work to node capacity is scheduling, not application logic, so it belongs here
 * rather than in a hand-rolled loop in each consumer.
 *
 * The ordering is carried as a per-pipeline overlay, so `needs` is never mutated and the same
 * task instances can be chained differently — or not at all — in another pipeline. Any `needs`
 * the tasks already declare are kept, so a chain can sit behind upstream tasks as usual.
 *
 * @example
 * ```ts
 * // Eleven image builds, two at a time, all behind the test tasks they already need.
 * const builds = images.map(img => imageBuildTask(img)); // each declares needs: [goTest]
 * new Pipeline({ tasks: [...withConcurrency(builds, 2)] });
 * ```
 */
export function withConcurrency(tasks: TaskLike[], max: number): TaskLike[] {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`withConcurrency: max must be a positive integer, got ${max}`);
  }
  if (tasks.length <= max) return [...tasks];
  return tasks.map((task, i) => {
    if (i < max) return task;
    // Task i waits on the one `max` places back: with max=1 that is a straight chain, and
    // with max=N it keeps N lanes running without pinning any task to a fixed lane.
    const predecessor = unwrapGated(tasks[i - max]);
    const overrides = task instanceof GatedTask ? task._overrides : {};
    const after = [...(overrides.after ?? []), predecessor];
    return gated(unwrapGated(task), { ...overrides, after });
  });
}

/**
 * Chains `tasks` so they run strictly one at a time — `withConcurrency(tasks, 1)`.
 *
 * @example
 * ```ts
 * new Pipeline({ tasks: [clone, ...serial([buildA, buildB, buildC])] });
 * // buildA → buildB → buildC, never two at once
 * ```
 */
export function serial(tasks: TaskLike[]): TaskLike[] {
  return withConcurrency(tasks, 1);
}
