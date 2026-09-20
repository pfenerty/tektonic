import type { Param } from './param';
import type { PipelineTrigger } from './trigger';
import type { TRIGGER_EVENTS } from './trigger-events';

/**
 * One environment variable injected into every step of every task, via the run's
 * `taskRunTemplate.podTemplate.env`.
 */
export interface PodEnvVar {
  name: string;
  value?: string;
  valueFrom?: Record<string, unknown>;
}

/** One task, rendered to a complete `kind: Task` manifest. */
export interface BuiltTask {
  /** The declared task name — the file name a target writes it under. */
  readonly name: string;
  /** `metadata.name` of the emitted resource: the declared name with the project prefix. */
  readonly resourceName: string;
  /** The full manifest, exactly as it should be written. */
  readonly manifest: Record<string, unknown>;
}

/** One pipeline, built to a Tekton `PipelineSpec` and everything a target needs around it. */
export interface BuiltPipeline {
  /** The declared pipeline name, without the project prefix. */
  readonly name: string;
  /** The emitted resource name: the declared name with the project prefix. */
  readonly resourceName: string;
  /** The built `PipelineSpec`: `params`, `workspaces`, `tasks` and `finally`. */
  readonly spec: Record<string, unknown>;
  /** Overall run timeout as a Go duration string, when the pipeline sets one. */
  readonly timeout?: string;
  /** Events the pipeline fires on. Empty when it has no trigger. */
  readonly events: TRIGGER_EVENTS[];
  /**
   * The firing config, for targets that deliver runs off VCS events. Undefined for a
   * pipeline with no trigger — which a target is free to emit anyway (a plain
   * `kind: Pipeline` needs no trigger) or skip (nothing would ever start it under PAC).
   */
  readonly trigger?: PipelineTrigger;
  /**
   * Workspace bindings for a run of this pipeline: a `persistentVolumeClaim` for every
   * cache workspace, a `volumeClaimTemplate` for every other. Targets that emit a
   * `PipelineRun` use these verbatim; targets that emit only a `Pipeline` ignore them.
   */
  readonly workspaceBindings: Record<string, unknown>[];
}

/** Run-level defaults that apply to every pipeline in the model. */
export interface SynthDefaults {
  /** Service account for run pods. */
  readonly serviceAccountName: string;
  /** Pod-level security context for every run pod. */
  readonly podSecurityContext: Record<string, unknown>;
  /** Environment injected into every step, targets' {@link SynthTarget.injectedEnv} included. */
  readonly podTemplateEnv: PodEnvVar[];
  /** Annotations to merge into every emitted run resource. */
  readonly runAnnotations: Record<string, string>;
}

/**
 * Everything a {@link SynthTarget} needs to emit a project, with no delivery-mechanism
 * concepts in it: no PAC annotations, no `{{ }}` template variables, no repository CR.
 * {@link TektonicProject} builds one of these and hands it to each of its targets.
 */
export interface SynthModel {
  /** Project name, used as the prefix in every `resourceName`. Undefined when unset. */
  readonly name?: string;
  /** Namespace every emitted resource belongs to. */
  readonly namespace: string;
  /** Every pipeline in the project, triggered or not, in declaration order. */
  readonly pipelines: BuiltPipeline[];
  /** Every unique task across all pipelines, rendered once. */
  readonly tasks: BuiltTask[];
  /** Run-level defaults. */
  readonly defaults: SynthDefaults;
}

/** One file a target wrote, reported back for drift checks and tests. */
export interface EmittedFile {
  /** Path of the file, relative to the outdir the target was given. */
  readonly path: string;
  /** The manifests the file contains, in document order. */
  readonly manifests: Record<string, unknown>[];
}

/**
 * A synthesis target: renders a {@link SynthModel} for one delivery mechanism.
 *
 * This is the seam between Tektonic's provider-neutral model and the YAML a particular
 * runner consumes. `PacTarget` (the default) emits PAC-annotated `PipelineRun` templates
 * plus a `Repository` CR; `TektonTarget` emits plain `kind: Pipeline` + `kind: Task` pairs.
 * A third party implements this interface to emit anything else — a Tekton Hub catalog
 * entry, a GitOps overlay, a different file layout — without editing the core.
 *
 * @example
 * ```ts
 * class ManifestListTarget implements SynthTarget {
 *   readonly name = 'manifest-list';
 *   emit(model: SynthModel, outdir: string): EmittedFile[] {
 *     const names = model.pipelines.map(p => p.resourceName).join('\n');
 *     fs.writeFileSync(path.join(outdir, 'pipelines.txt'), names);
 *     return [{ path: 'pipelines.txt', manifests: [] }];
 *   }
 * }
 *
 * new TektonicProject({ namespace: 'ci', pipelines, targets: [new PacTarget(), new ManifestListTarget()] });
 * ```
 */
export interface SynthTarget {
  /** Short identifier, e.g. `'pac'`, `'tekton'`, `'hub'`. */
  readonly name: string;
  /**
   * Params this target binds on every run and therefore needs declared on every pipeline
   * spec, whether or not a task asked for one. The union across a project's targets is
   * added to every built spec before {@link emit} is called.
   */
  readonly injectedParams?: Param[];
  /**
   * Environment this target contributes to every step — the delivery mechanism's event
   * context, typically. Merged into {@link SynthDefaults.podTemplateEnv}, where an entry the
   * project declared itself wins.
   */
  readonly injectedEnv?: PodEnvVar[];
  /**
   * Writes this model's files under `outdir` and returns what it wrote.
   *
   * Targets own the file names they write: when a project combines several, give them
   * distinct layouts so they do not overwrite each other.
   */
  emit(model: SynthModel, outdir: string): EmittedFile[];
}
