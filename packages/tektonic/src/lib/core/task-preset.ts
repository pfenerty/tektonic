import { TaskDef } from './task';
import type { TaskOptions, TaskStepSpec } from './task';
import { Action } from './action';
import type { Param } from './param';
import type { Workspace } from './workspace';

/**
 * Defaults a {@link taskPreset} applies to the tasks it builds.
 *
 * Everything {@link TaskOptions} accepts except `name` and `steps`, which identify the task
 * and therefore always come from the call, plus {@link TaskPresetDefaults.step} for defaults
 * that belong on each step rather than the task.
 *
 * `produces` is excluded too: an artifact names a file one particular task writes, so a
 * preset stamping the same declaration onto every task it builds could only be wrong.
 * `artifactStore` and `artifactWorkspace` are *not* excluded — those are exactly the
 * project-wide conventions a preset exists to state once.
 */
export interface TaskPresetDefaults
  extends Omit<Partial<TaskOptions>, 'name' | 'steps' | 'produces'> {
  /**
   * Fields merged into every step of the built task — `computeResources`, `env`, `image`,
   * a `securityContext`. A step's own value wins per field, and `env` merges by name.
   */
  step?: Partial<TaskStepSpec>;
}

/** Merges two `env` lists, letting the later one win per variable name. */
function mergeEnv(base: TaskStepSpec['env'], override: TaskStepSpec['env']): TaskStepSpec['env'] {
  if (!base) return override;
  if (!override) return base;
  const overridden = new Set(override.map(e => e.name));
  return [...base.filter(e => !overridden.has(e.name)), ...override];
}

/** Concatenates two lists of named things, keeping the first occurrence of each name. */
function mergeNamed<T extends { name: string }>(base: T[] = [], extra: T[] = []): T[] {
  const seen = new Map<string, T>();
  for (const item of [...base, ...extra]) {
    if (!seen.has(item.name)) seen.set(item.name, item);
  }
  return [...seen.values()];
}

/**
 * Builds a task factory that stamps shared defaults onto every task it creates.
 *
 * A project's tasks usually agree on more than they differ: the same status reporter, the
 * same compute resources, the same base env, the same workspace. Restating those on every
 * task is where they drift — one task quietly reporting no status, another sized for a
 * different node. A preset states them once.
 *
 * This is also the seam a **job library** builds on: a published `depScanTask({ image, … })`
 * is a function that fills in steps and returns a `Task`, and a preset is how the consuming
 * project applies its own conventions to it.
 *
 * Merge rules — the call always wins:
 * - `name` and `steps` come from the call; the preset cannot supply them.
 * - `params`, `workspaces`, `needs`, `caches`, `sidecars`, `volumes`, `consumes`: preset
 *   entries first, then the call's; params, workspaces, caches, sidecars and volumes dedupe
 *   by name.
 * - `stepTemplate` and `annotations`: shallow-merged, the call winning per key.
 * - everything else scalar (`statusReporter`, `when`, `timeout`, …): the call's value when it
 *   is defined, else the preset's.
 * - `step`: merged into each of the call's steps, the step winning per field, `env` by name
 *   and `volumeMounts` concatenated.
 *
 * @example
 * ```ts
 * const ciTask = taskPreset({
 *   statusReporter,
 *   workspaces: [workspace],
 *   step: {
 *     computeResources: { requests: { cpu: '250m', memory: '512Mi' } },
 *     env: [{ name: 'CI', value: 'true' }],
 *   },
 * });
 *
 * const test = ciTask({ name: 'test', steps: [{ name: 'test', image: goImage, script: sh`go test ./...` }] });
 * ```
 */
export function taskPreset(
  defaults: TaskPresetDefaults,
): <AN extends string = never>(opts: TaskOptions<AN>) => TaskDef<AN> {
  const { step: stepDefaults, ...taskDefaults } = defaults;

  return <AN extends string = never>(opts: TaskOptions<AN>): TaskDef<AN> => {
    const withDefaults = (step: TaskStepSpec): TaskStepSpec => {
      if (!stepDefaults) return step;
      return {
        ...stepDefaults,
        ...step,
        ...(mergeEnv(stepDefaults.env, step.env) ? { env: mergeEnv(stepDefaults.env, step.env) } : {}),
        ...(stepDefaults.volumeMounts || step.volumeMounts
          ? { volumeMounts: [...(stepDefaults.volumeMounts ?? []), ...(step.volumeMounts ?? [])] }
          : {}),
      } as TaskStepSpec;
    };

    // A composed action's steps take the preset too — a library action should pick up the
    // project's resources, base env and security context the way a hand-written step does.
    const steps = opts.steps.map(step =>
      step instanceof Action ? step._withSteps(withDefaults) : withDefaults(step),
    );

    return new TaskDef<AN>({
      ...taskDefaults,
      ...opts,
      steps,
      consumes: [...(taskDefaults.consumes ?? []), ...(opts.consumes ?? [])],
      params: mergeNamed<Param>(taskDefaults.params, opts.params),
      workspaces: mergeNamed<Workspace>(taskDefaults.workspaces, opts.workspaces),
      needs: [...(taskDefaults.needs ?? []), ...(opts.needs ?? [])],
      caches: mergeNamed(taskDefaults.caches, opts.caches),
      sidecars: mergeNamed(taskDefaults.sidecars, opts.sidecars),
      volumes: mergeNamed(taskDefaults.volumes, opts.volumes),
      ...(taskDefaults.stepTemplate || opts.stepTemplate
        ? { stepTemplate: { ...taskDefaults.stepTemplate, ...opts.stepTemplate } }
        : {}),
      ...(taskDefaults.annotations || opts.annotations
        ? { annotations: { ...taskDefaults.annotations, ...opts.annotations } }
        : {}),
    });
  };
}
