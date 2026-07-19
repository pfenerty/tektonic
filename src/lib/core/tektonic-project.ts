import { App, ApiObject, Chart } from 'cdk8s';
import { Pipeline } from './pipeline';
import { TaskLike, TaskDef } from './task';
import { Workspace } from './workspace';
import { TRIGGER_EVENTS } from './trigger-events';
import { TEKTON_API_V1, PAC_API, DEFAULT_POD_SECURITY_CONTEXT } from '../constants';
import type { CacheBackend } from './cache-backend';
import type { LanguageName } from '../script';

/**
 * Specifies a persistent cache volume bound into every PipelineRun. The generated
 * PVC persists across runs so tools can reuse cached data (a vulnerability database,
 * dependencies, build artifacts).
 */
export interface CacheSpec {
  /** The workspace bound to the persistent volume across PipelineRuns. */
  workspace: Workspace;
  /** PVC storage size. Defaults to `'1Gi'`. */
  storageSize?: string;
  /**
   * Name of the PersistentVolumeClaim to bind. Defaults to
   * `${projectName}-${workspace.name}` when the project has a name, else `${workspace.name}`.
   */
  claimName?: string;
  /** StorageClass for the PVC. Omitted when unset — cluster default applies. */
  storageClassName?: string;
  /** Access modes for the cache PVC. Defaults to `['ReadWriteOnce']`. */
  accessModes?: string[];
  /**
   * Cache storage backend. When set to `gcs({ ... })`, no PVC is bound for
   * this cache — archives are stored in GCS instead.
   */
  backend?: CacheBackend;
}

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

// Maps TRIGGER_EVENTS values to PAC on-event annotation strings
const PAC_EVENT: Partial<Record<TRIGGER_EVENTS, string>> = {
  [TRIGGER_EVENTS.PUSH]: 'push',
  [TRIGGER_EVENTS.PULL_REQUEST]: 'pull_request',
  [TRIGGER_EVENTS.TAG]: 'push',
};

// Well-known pipeline params bound to PAC template variables
const PAC_PARAM_BINDINGS: Record<string, string> = {
  url: '{{ repo_url }}',
  revision: '{{ revision }}',
  'project-name': '{{ repo_name }}',
  'repo-full-name': '{{ repo_owner }}/{{ repo_name }}',
  'source-branch': '{{ source_branch }}',
};

const EXTRA_PIPELINE_PARAMS = [
  { name: 'project-name', type: 'string' },
  { name: 'repo-full-name', type: 'string' },
  { name: 'source-branch', type: 'string' },
];

/** Options for {@link TektonicProject}. */
export interface TektonicProjectOptions {
  /**
   * Generate a PAC `Repository` custom resource linking this repo to the namespace
   * (and, optionally, a git provider). Omit to manage the `Repository` yourself.
   */
  repository?: RepositoryConfig;
  /** Optional name prefix applied to all generated resource names. */
  name?: string;
  /** Kubernetes namespace for task and PipelineRun resources. */
  namespace: string;
  /** Pipelines to synthesize. Only pipelines with triggers are emitted. */
  pipelines: Pipeline[];
  /** Persistent cache volumes to bind in every PipelineRun. */
  caches?: CacheSpec[];
  /**
   * Output directory for synthesized YAML files. Defaults to `".tekton"`.
   * Task files are written to `<outdir>/tasks/`.
   */
  outdir?: string;
  /**
   * Repo-relative path used in PAC task annotations.
   * Set this when `outdir` is not a repo-relative path
   * (e.g. `outdir: "../../.tekton"`, `repoRelativePath: ".tekton"`).
   * Defaults to `outdir`.
   */
  repoRelativePath?: string;
  /** PVC storage size for the per-run ephemeral workspace. Defaults to `"1Gi"`. */
  workspaceStorageSize?: string;
  /** StorageClass for the ephemeral workspace PVC. Omitted when unset. */
  workspaceStorageClass?: string;
  /** Access modes for the ephemeral workspace PVC. Defaults to `["ReadWriteOnce"]`. */
  workspaceAccessModes?: string[];
  /**
   * Pod-level security context merged on top of `DEFAULT_POD_SECURITY_CONTEXT`
   * for every PipelineRun pod.
   */
  defaultPodSecurityContext?: Record<string, unknown>;
  /**
   * Container-level security context merged on top of `DEFAULT_STEP_SECURITY_CONTEXT`
   * for every task's stepTemplate.
   */
  defaultStepSecurityContext?: Record<string, unknown>;
  /**
   * Default scripting language for steps whose `script` is a bare body (a
   * `{ language, body }` object or a raw string without a shebang). Individual
   * tasks override via their own `defaultLanguage`; tagged bodies always win.
   */
  defaultLanguage?: LanguageName;
  /** Service account name for PipelineRun pods. Defaults to `"tekton-triggers"`. */
  serviceAccountName?: string;
  /**
   * Maximum number of completed PipelineRuns to retain per repository.
   * PAC deletes older runs once this limit is exceeded. Defaults to `5`.
   */
  maxKeepRuns?: number;
  /**
   * Additional environment variables injected into every step of every task via
   * `taskRunTemplate.podTemplate.env`. Applied to all TaskRun pods in all PipelineRuns.
   *
   * PAC template variables (e.g. `{{ git_auth_secret }}`) in `valueFrom.secretKeyRef.name`
   * are substituted by PAC before the PipelineRun is submitted to Kubernetes, so they
   * resolve to concrete secret names by the time Kubernetes processes the resource.
   *
   * @example
   * ```ts
   * podTemplateEnv: [{
   *   name: 'GITHUB_TOKEN',
   *   valueFrom: { secretKeyRef: { name: '{{ git_auth_secret }}', key: 'git-provider-token' } },
   * }]
   * ```
   */
  podTemplateEnv?: Array<{ name: string; value?: string; valueFrom?: Record<string, unknown> }>;
  /**
   * Annotations merged into every generated PipelineRun's metadata, alongside the
   * PAC annotations. Use for Tekton Chains controls such as
   * `chains.tekton.dev/transparency-upload`.
   */
  pipelineRunAnnotations?: Record<string, string>;
}

/**
 * Synthesizes a Tektonic project to Tekton [Pipelines as Code](https://pipelinesascode.tekton.dev/)
 * (PAC) YAML — the single Tektonic synthesizer.
 *
 * It generates:
 * - PAC-annotated `PipelineRun` templates in `<outdir>/` (one per triggered pipeline)
 * - `Task` YAML files in `<outdir>/tasks/` (one per unique task)
 * - an optional `Repository` custom resource (when {@link RepositoryConfig | repository} is set)
 *
 * PAC reads these files directly from the pushed commit's SHA at runtime, so the
 * pipeline definition is always exactly what was committed — no Flux sync race.
 *
 * @example
 * ```ts
 * new TektonicProject({
 *   name: 'ocidex',
 *   namespace: 'ocidex-ci',
 *   pipelines: [pushPipeline, prPipeline],
 *   outdir: '../.tekton',
 *   repoRelativePath: '.tekton',
 *   repository: { url: 'https://github.com/pfenerty/ocidex' },
 *   caches: [
 *     { workspace: goCacheWs, storageSize: '5Gi', storageClassName: 'local-path' },
 *   ],
 *   defaultPodSecurityContext: { runAsUser: 1024, runAsGroup: 1024, fsGroup: 1024 },
 * });
 * ```
 */
export class TektonicProject {
  constructor(opts: TektonicProjectOptions) {
    const outdir = opts.outdir ?? '.tekton';
    const repoRelativePath = opts.repoRelativePath ?? outdir;
    const prefix = opts.name ?? '';
    const namespace = opts.namespace;
    const serviceAccountName = opts.serviceAccountName ?? 'tekton-triggers';
    const maxKeepRuns = opts.maxKeepRuns ?? 5;

    const podSecurityContext = {
      ...DEFAULT_POD_SECURITY_CONTEXT,
      ...(opts.defaultPodSecurityContext ?? {}),
    };

    const pvcCaches = (opts.caches ?? []).filter(c => c.backend?.type !== 'gcs');

    // 1. Collect unique tasks across all pipelines (including finally tasks)
    const uniqueTasks = new Map<string, TaskLike>();
    for (const pipeline of opts.pipelines) {
      for (const task of [...pipeline.allTasks, ...pipeline.finallyTasks]) {
        if (!uniqueTasks.has(task.name)) uniqueTasks.set(task.name, task);
      }
    }

    // 2. Synthesize Task YAML to <outdir>/tasks/
    const taskApp = new App({ outdir: `${outdir}/tasks` });
    for (const [name, task] of uniqueTasks) {
      if (!(task instanceof TaskDef)) continue;
      const chart = new Chart(taskApp, name);
      task.synth(chart, namespace, prefix || undefined, opts.defaultStepSecurityContext, opts.defaultLanguage);
    }
    taskApp.synth();

    // 3. Build task annotation: references to all synthesized task files
    const synthTaskNames = [...uniqueTasks.entries()]
      .filter(([, t]) => t instanceof TaskDef)
      .map(([name]) => {
        // The chart ID used above is the bare task name; cdk8s suffixes .k8s.yaml
        const fileName = `${name}.k8s.yaml`;
        return `${repoRelativePath}/tasks/${fileName}`;
      });
    const taskAnnotation = synthTaskNames.length > 0
      ? `[${synthTaskNames.join(', ')}]`
      : undefined;

    // 4. Synthesize a PAC PipelineRun template per triggered pipeline
    const runApp = new App({ outdir });
    for (const pipeline of opts.pipelines) {
      if (pipeline.triggers.length === 0) continue;

      // Determine PAC on-event and on-target-branch
      const events = [...new Set(pipeline.triggers.map(t => PAC_EVENT[t]).filter(Boolean))] as string[];
      if (events.length === 0) continue;

      const isTagPipeline = pipeline.triggers.includes(TRIGGER_EVENTS.TAG);
      const onEvent = `[${events.join(', ')}]`;
      const onTargetBranch = isTagPipeline
        ? '[refs/tags/*]'
        : `[${pipeline.onTargetBranch}]`;

      // PAC pipeline-level matching annotations. `on-cel-expression` replaces
      // `on-event`/`on-target-branch`; the rest combine.
      const PAC = 'pipelinesascode.tekton.dev';
      const pacList = (xs: string[]) => `[${xs.join(', ')}]`;
      const m = pipeline.match;
      const matchAnnotations: Record<string, string> = {
        ...(m?.cel
          ? { [`${PAC}/on-cel-expression`]: m.cel }
          : { [`${PAC}/on-event`]: onEvent, [`${PAC}/on-target-branch`]: onTargetBranch }),
        ...(m?.pathsChanged?.length ? { [`${PAC}/on-path-changed`]: pacList(m.pathsChanged) } : {}),
        ...(m?.pathsIgnored?.length ? { [`${PAC}/on-path-change-ignore`]: pacList(m.pathsIgnored) } : {}),
        ...(m?.onComment ? { [`${PAC}/on-comment`]: m.onComment } : {}),
        ...(m?.onLabel?.length ? { [`${PAC}/on-label`]: pacList(m.onLabel) } : {}),
        ...(m?.cancelInProgress ? { [`${PAC}/cancel-in-progress`]: 'true' } : {}),
      };

      // Build the inlined pipeline spec (with auto-injected project-name / repo-full-name params)
      const pipelineSpec = pipeline._buildSpec(EXTRA_PIPELINE_PARAMS, prefix || undefined);

      // Bind all pipelineSpec params to PAC template variables
      const specParams = pipelineSpec.params as Array<{ name: string }>;
      const pipelineRunParams = specParams.map(p => ({
        name: p.name,
        value: PAC_PARAM_BINDINGS[p.name] ?? '',
      }));

      // Workspace bindings: cache workspaces → PVCs, all others → ephemeral volumeClaimTemplate
      const cacheWorkspaceNames = new Set(pvcCaches.map(c => c.workspace.name));
      const specWorkspaces = pipelineSpec.workspaces as Array<{ name: string }>;
      const workspaces = specWorkspaces.map(w => {
        if (cacheWorkspaceNames.has(w.name)) {
          const cacheSpec = pvcCaches.find(c => c.workspace.name === w.name)!;
          const claimName = cacheSpec.claimName
            ?? (prefix ? `${prefix}-${w.name}` : w.name);
          return { name: w.name, persistentVolumeClaim: { claimName } };
        }
        return {
          name: w.name,
          volumeClaimTemplate: {
            spec: {
              accessModes: opts.workspaceAccessModes ?? ['ReadWriteOnce'],
              ...(opts.workspaceStorageClass ? { storageClassName: opts.workspaceStorageClass } : {}),
              resources: { requests: { storage: opts.workspaceStorageSize ?? '1Gi' } },
            },
          },
        };
      });

      const pipelineRunName = prefix ? `${prefix}-${pipeline.name}` : pipeline.name;
      const chartId = prefix ? `${prefix}-${pipeline.name}` : pipeline.name;

      const chart = new Chart(runApp, chartId);
      new ApiObject(chart, 'pipelinerun', {
        apiVersion: TEKTON_API_V1,
        kind: 'PipelineRun',
        metadata: {
          name: pipelineRunName,
          annotations: {
            ...matchAnnotations,
            ...(taskAnnotation ? { 'pipelinesascode.tekton.dev/task': taskAnnotation } : {}),
            'pipelinesascode.tekton.dev/max-keep-runs': String(maxKeepRuns),
            ...(opts.pipelineRunAnnotations ?? {}),
          },
        },
        spec: {
          pipelineSpec,
          ...(pipeline.timeout ? { timeouts: { pipeline: pipeline.timeout } } : {}),
          params: pipelineRunParams,
          taskRunTemplate: {
            serviceAccountName,
            podTemplate: {
              securityContext: podSecurityContext,
              ...(opts.podTemplateEnv && opts.podTemplateEnv.length > 0
                ? { env: opts.podTemplateEnv }
                : {}),
            },
          },
          workspaces,
        },
      });
    }

    // Optional PAC Repository CR linking this repo to the namespace (+ provider).
    if (opts.repository) {
      const repoName = prefix || opts.repository.url.replace(/^.*\//, '') || 'repository';
      const gp = opts.repository.gitProvider;
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
      const repoChart = new Chart(runApp, `${repoName}-repository`);
      new ApiObject(repoChart, 'repository', {
        apiVersion: PAC_API,
        kind: 'Repository',
        metadata: { name: repoName, namespace },
        spec: {
          url: opts.repository.url,
          ...(gitProvider ? { git_provider: gitProvider } : {}),
        },
      });
    }

    runApp.synth();
  }
}
