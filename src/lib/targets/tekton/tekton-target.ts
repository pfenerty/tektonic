import { App, ApiObject, Chart } from 'cdk8s';
import type { ApiObjectProps } from 'cdk8s';
import { TEKTON_API_V1 } from '../../constants';
import type { Pipeline } from '../../core/pipeline';
import type { EmittedFile, SynthModel, SynthTarget } from '../../core/synth-target';

/** Options for {@link pipelineManifest}. */
export interface PipelineManifestOptions {
  /** Namespace for the emitted resource. */
  namespace: string;
  /** Name prefix applied to the resource name, as `TektonicProject.name` does. */
  namePrefix?: string;
  /** Extra pipeline-level params, as a synthesis target injects for its own bindings. */
  extraParams?: Record<string, unknown>[];
}

/**
 * Renders one pipeline as a standalone `kind: Pipeline` manifest.
 *
 * This is the single-pipeline form of what {@link TektonTarget} emits — useful for tests and
 * for code that wants one manifest without running a whole project synthesis.
 */
export function pipelineManifest(
  pipeline: Pipeline,
  opts: PipelineManifestOptions,
): Record<string, unknown> {
  const chart = new Chart(new App(), 'pipeline');
  new ApiObject(chart, 'pipeline', {
    apiVersion: TEKTON_API_V1,
    kind: 'Pipeline',
    metadata: {
      name: opts.namePrefix ? `${opts.namePrefix}-${pipeline.name}` : pipeline.name,
      namespace: opts.namespace,
    },
    spec: pipeline._buildSpec(opts.extraParams, opts.namePrefix),
  });
  return chart.toJson()[0] as Record<string, unknown>;
}

/** Options for {@link TektonTarget}. */
export interface TektonTargetOptions {
  /**
   * Subdirectory of the outdir for `Pipeline` files. Defaults to the outdir itself.
   */
  pipelineDir?: string;
  /** Subdirectory of the outdir for `Task` files. Defaults to `'tasks'`. */
  taskDir?: string;
}

/**
 * The plain-Tekton synthesis target: a `kind: Pipeline` per pipeline and a `kind: Task` per
 * unique task, with nothing PAC-specific in them.
 *
 * Use it where runs are started by something other than Pipelines as Code — `tkn pipeline
 * start`, a Trigger/EventListener, a GitOps sync — or alongside {@link PacTarget} to publish
 * the same graph in both forms. Unlike the PAC target it emits untriggered pipelines too: a
 * `Pipeline` resource needs no event to be worth applying.
 *
 * Run-level concerns (workspace bindings, the pod template, the service account) belong to a
 * `PipelineRun`, so a `Pipeline` resource carries none of them — they stay on the model for
 * whoever starts the run.
 */
export class TektonTarget implements SynthTarget {
  readonly name = 'tekton';

  constructor(private readonly opts: TektonTargetOptions = {}) {}

  emit(model: SynthModel, outdir: string): EmittedFile[] {
    const files: EmittedFile[] = [];
    const taskDir = this.opts.taskDir ?? 'tasks';
    const pipelineDir = this.opts.pipelineDir ?? '';
    const under = (dir: string): string => (dir ? `${outdir}/${dir}` : outdir);
    const at = (dir: string, file: string): string => (dir ? `${dir}/${file}` : file);

    const taskApp = new App({ outdir: under(taskDir) });
    for (const task of model.tasks) {
      const chart = new Chart(taskApp, task.name);
      new ApiObject(chart, 'task', task.manifest as unknown as ApiObjectProps);
      files.push({ path: at(taskDir, `${task.name}.k8s.yaml`), manifests: [task.manifest] });
    }
    taskApp.synth();

    const pipelineApp = new App({ outdir: under(pipelineDir) });
    for (const pipeline of model.pipelines) {
      const manifest = {
        apiVersion: TEKTON_API_V1,
        kind: 'Pipeline',
        metadata: { name: pipeline.resourceName, namespace: model.namespace },
        spec: pipeline.spec,
      };
      const chart = new Chart(pipelineApp, pipeline.resourceName);
      new ApiObject(chart, 'pipeline', manifest);
      files.push({ path: at(pipelineDir, `${pipeline.resourceName}.k8s.yaml`), manifests: [manifest] });
    }
    pipelineApp.synth();

    return files;
  }
}
