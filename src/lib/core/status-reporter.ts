import { Task } from './task';
import type { TaskStepSpec } from './task';
import { Param } from './param';

/**
 * Provider-agnostic interface for reporting pipeline task statuses to an external system.
 *
 * Implementations supply:
 * - A factory to create the pending task that runs first in the pipeline
 * - A step that reports the final status (success/failure) at the end of each task
 */
export interface StatusReporter {
  /**
   * Creates a Task that sets all given contexts to "pending".
   * This task should run before any other task in the pipeline.
   */
  createPendingTask(contexts: string[]): Task;

  /**
   * Returns a step that reports the final status of the given context.
   * The step reads the captured exit code from {@link EXIT_CODE_PATH} and
   * reports success or failure accordingly.
   *
   * `TaskDef.synth` appends this as the last step and, for every preceding user
   * step, automatically enables exit-code capture and sets `onError: 'continue'`
   * — so the user body just exits naturally; no manual contract-file writes are
   * needed.
   */
  finalStep(context: string): TaskStepSpec;

  /** Parameters required by this reporter (e.g., repo name, revision). */
  readonly requiredParams: Param[];
}
