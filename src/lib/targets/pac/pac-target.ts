import { App, ApiObject, Chart } from 'cdk8s';
import type { ApiObjectProps } from 'cdk8s';
import { TEKTON_API_V1, PAC_API } from '../../constants';
import type { EmittedFile, PodEnvVar, SynthModel, SynthTarget } from '../../core/synth-target';
import { PAC_EVENT_ENV, PAC_INJECTED_PARAMS, PAC_PARAM_BINDINGS } from './params';
import { PAC_ANNOTATION_PREFIX, triggerAnnotations } from './trigger-annotations';

/**
 * Git provider configuration for a generated PAC {@link RepositoryConfig}. Omit
 * entirely when PAC is installed as a GitHub App (URL matching is sufficient).
 */
export interface RepositoryGitProvider {
  /** Provider type, e.g. `'github'`, `'gitlab'`, `'bitbucket-cloud'`, `'gitea'`. */
  type?: 'github' | 'gitlab' | 'bitbucket-cloud' | 'gitea';
  /** Name of the Secret holding the provider API token. */
  secretName?: string;
  /** Key within the token Secret. Defaults to `'token'`. */
  secretKey?: string;
  /** Name of the Secret holding the webhook secret (for webhook-based installs). */
  webhookSecretName?: string;
  /** Key within the webhook Secret. Defaults to `'webhook.secret'`. */
  webhookSecretKey?: string;
  /** API base URL for self-hosted providers (e.g. GitHub Enterprise, self-hosted GitLab). */
  apiUrl?: string;
}

/** Options for generating a PAC `Repository` custom resource. */
export interface RepositoryConfig {
  /** Repository URL PAC matches incoming events against (`spec.url`). */
  url: string;
  /** Optional git-provider block. Omit for GitHub-App installs. */
  gitProvider?: RepositoryGitProvider;
}

/** Options for {@link PacTarget}. */
export interface PacTargetOptions {
  /**
   * Generate a PAC `Repository` custom resource linking this repo to the namespace
   * (and, optionally, a git provider). Omit to manage the `Repository` yourself.
   */
  repository?: RepositoryConfig;
  /**
   * Repo-relative path the emitted task annotations point at. Set it when the outdir is
   * not a repo-relative path (e.g. outdir `../../.tekton`, `repoRelativePath: '.tekton'`).
   * Defaults to the outdir the target is given.
   */
  repoRelativePath?: string;
  /**
   * Maximum number of completed PipelineRuns PAC retains per repository. Defaults to `5`.
   */
  maxKeepRuns?: number;
  /**
   * Inject the PAC event context — event type, branches, revision, repo — into every step as
   * environment variables under the stable names in {@link PAC_EVENT_ENV}. Defaults to `false`.
   */
  eventContext?: boolean;
}

/**
 * The [Pipelines as Code](https://pipelinesascode.tekton.dev/) synthesis target, and
 * {@link TektonicProject}'s default.
 *
 * It renders a {@link SynthModel} as:
 * - PAC-annotated `PipelineRun` templates in `<outdir>/` (one per triggered pipeline), with
 *   the pipeline spec inlined and every well-known param bound to its `{{ }}` variable
 * - `Task` YAML in `<outdir>/tasks/` (one file per unique task)
 * - an optional `Repository` custom resource
 *
 * PAC reads these files from the pushed commit's SHA at run time, so what runs is exactly
 * what was committed. Every PAC concept in Tektonic lives here: no other module emits a
 * `pipelinesascode.tekton.dev` annotation or a `{{ }}` template variable.
 */
export class PacTarget implements SynthTarget {
  readonly name = 'pac';
  /** PAC fills these on every run, so every pipeline must declare them. */
  readonly injectedParams = PAC_INJECTED_PARAMS;
  readonly injectedEnv?: PodEnvVar[];

  constructor(private readonly opts: PacTargetOptions = {}) {
    this.injectedEnv = opts.eventContext
      ? Object.entries(PAC_EVENT_ENV).map(([name, value]) => ({ name, value }))
      : undefined;
  }

  emit(model: SynthModel, outdir: string): EmittedFile[] {
    const files: EmittedFile[] = [];
    const repoRelativePath = this.opts.repoRelativePath ?? outdir;
    const maxKeepRuns = this.opts.maxKeepRuns ?? 5;

    // 1. One Task file per unique task, under <outdir>/tasks/.
    const taskApp = new App({ outdir: `${outdir}/tasks` });
    for (const task of model.tasks) {
      const chart = new Chart(taskApp, task.name);
      new ApiObject(chart, 'task', task.manifest as unknown as ApiObjectProps);
      files.push({ path: `tasks/${task.name}.k8s.yaml`, manifests: [task.manifest] });
    }
    taskApp.synth();

    // 2. The PAC task annotation: references to every task file, as PAC resolves them from
    //    the commit under test.
    const taskAnnotation = model.tasks.length > 0
      ? `[${model.tasks.map(t => `${repoRelativePath}/tasks/${t.name}.k8s.yaml`).join(', ')}]`
      : undefined;

    // 3. A PipelineRun template per triggered pipeline. An untriggered pipeline is skipped:
    //    PAC starts runs from events, so nothing would ever fire it.
    const runApp = new App({ outdir });
    for (const pipeline of model.pipelines) {
      if (!pipeline.trigger || pipeline.events.length === 0) continue;

      const params = ((pipeline.spec.params ?? []) as Array<{ name: string }>).map(p => ({
        name: p.name,
        value: PAC_PARAM_BINDINGS[p.name] ?? '',
      }));

      const manifest = {
        apiVersion: TEKTON_API_V1,
        kind: 'PipelineRun',
        metadata: {
          name: pipeline.resourceName,
          annotations: {
            ...triggerAnnotations(pipeline.trigger),
            ...(taskAnnotation ? { [`${PAC_ANNOTATION_PREFIX}/task`]: taskAnnotation } : {}),
            [`${PAC_ANNOTATION_PREFIX}/max-keep-runs`]: String(maxKeepRuns),
            ...model.defaults.runAnnotations,
          },
        },
        spec: {
          pipelineSpec: pipeline.spec,
          ...(pipeline.timeout ? { timeouts: { pipeline: pipeline.timeout } } : {}),
          params,
          taskRunTemplate: {
            serviceAccountName: model.defaults.serviceAccountName,
            podTemplate: {
              securityContext: model.defaults.podSecurityContext,
              ...(model.defaults.podTemplateEnv.length > 0
                ? { env: model.defaults.podTemplateEnv }
                : {}),
            },
          },
          workspaces: pipeline.workspaceBindings,
        },
      };

      const chart = new Chart(runApp, pipeline.resourceName);
      new ApiObject(chart, 'pipelinerun', manifest);
      files.push({ path: `${pipeline.resourceName}.k8s.yaml`, manifests: [manifest] });
    }

    // 4. Optional Repository CR linking this repo to the namespace (+ provider).
    if (this.opts.repository) {
      const repoName = model.name || this.opts.repository.url.replace(/^.*\//, '') || 'repository';
      const gp = this.opts.repository.gitProvider;
      const gitProvider = gp
        ? {
            ...(gp.type ? { type: gp.type } : {}),
            ...(gp.apiUrl ? { url: gp.apiUrl } : {}),
            ...(gp.secretName
              ? { secret: { name: gp.secretName, key: gp.secretKey ?? 'token' } }
              : {}),
            ...(gp.webhookSecretName
              ? {
                  webhook_secret: {
                    name: gp.webhookSecretName,
                    key: gp.webhookSecretKey ?? 'webhook.secret',
                  },
                }
              : {}),
          }
        : undefined;
      const manifest = {
        apiVersion: PAC_API,
        kind: 'Repository',
        metadata: { name: repoName, namespace: model.namespace },
        spec: {
          url: this.opts.repository.url,
          ...(gitProvider ? { git_provider: gitProvider } : {}),
        },
      };
      const repoChart = new Chart(runApp, `${repoName}-repository`);
      new ApiObject(repoChart, 'repository', manifest);
      files.push({ path: `${repoName}-repository.k8s.yaml`, manifests: [manifest] });
    }

    runApp.synth();
    return files;
  }
}
