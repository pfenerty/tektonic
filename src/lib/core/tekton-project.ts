import { App, Chart } from 'cdk8s';
import { TektonInfraChart } from '../../charts/tekton-infra.chart';
import { Pipeline } from './pipeline';
import { TaskLike, TaskDef } from './task';
import { Workspace } from './workspace';
import { TRIGGER_EVENTS } from './trigger-events';
import type { CacheBackend } from './cache-backend';
import type { VcsProvider } from '../triggers/vcs-provider';

/**
 * Specifies a persistent cache volume to provision and bind for a pipeline workspace.
 * The generated PVC persists across PipelineRuns so tools can reuse cached data
 * (e.g. a vulnerability database, downloaded dependencies, build artifacts).
 */
export interface CacheSpec {
  /** The workspace that will be bound to the persistent volume across PipelineRuns. */
  workspace: Workspace;
  /** PVC storage size. Defaults to `'1Gi'`. */
  storageSize?: string;
  /**
   * Name of the PersistentVolumeClaim resource to create.
   * Defaults to `${projectName}-${workspace.name}` when the project has a name,
   * or just `${workspace.name}` otherwise.
   */
  claimName?: string;
  /** StorageClass for the PVC. Omitted when not set — cluster default applies. */
  storageClassName?: string;
  /**
   * Cache storage backend. When set to `{ type: 'gcs', ... }`, no PVC is
   * provisioned for this cache — archives are stored in GCS instead.
   */
  backend?: CacheBackend;
}

/** Options for constructing a {@link TektonProject}. */
export interface TektonProjectOptions {
  /** Optional name prefix applied to all generated resource names. */
  name?: string;
  /** Kubernetes namespace for all generated resources. */
  namespace: string;
  /** Pipelines to synthesize. */
  pipelines: Pipeline[];
  /** Service account name for trigger infrastructure. Defaults to `"tekton-triggers"`. */
  serviceAccountName?: string;
  /** PVC size for the ephemeral pipeline workspace volumes. Defaults to `"1Gi"`. */
  workspaceStorageSize?: string;
  /** StorageClass for the ephemeral workspace PVC. Omitted when not set — cluster default applies. */
  workspaceStorageClass?: string;
  /** Access modes for the ephemeral workspace PVC. Defaults to `["ReadWriteOnce"]`. */
  workspaceAccessModes?: string[];
  /** Persistent cache volumes to provision and bind in every PipelineRun. */
  caches?: CacheSpec[];
  /** Kubernetes Secret reference for GitHub webhook validation. */
  webhookSecretRef?: { secretName: string; secretKey: string };
  /** Output directory for synthesized YAML. Defaults to cdk8s default (`dist`). */
  outdir?: string;
  /** Pipeline param name that receives the repository URL. Defaults to `"url"`. */
  urlParam?: string;
  /** Pipeline param name that receives the git revision. Defaults to `"revision"`. */
  revisionParam?: string;
  /** Pipeline param name that receives the git ref (branch/tag ref). */
  gitRefParam?: string;
  /**
   * Pod-level security context merged on top of `DEFAULT_POD_SECURITY_CONTEXT` for every
   * PipelineRun pod. Use this to override defaults such as `fsGroup` or `runAsUser`.
   */
  defaultPodSecurityContext?: Record<string, unknown>;
  /**
   * Container-level security context merged on top of `DEFAULT_STEP_SECURITY_CONTEXT` for
   * every task's `stepTemplate`. Individual tasks can further override via their own
   * `stepTemplate.securityContext`; individual steps can override via `step.securityContext`.
   */
  defaultStepSecurityContext?: Record<string, unknown>;
  /**
   * Additional annotations to apply to the generated Tekton triggers ServiceAccount.
   * Use this to configure GKE Workload Identity, e.g.:
   *
   * ```ts
   * serviceAccountAnnotations: {
   *   'iam.gke.io/gcp-service-account': 'tekton-ci@my-project.iam.gserviceaccount.com',
   * }
   * ```
   */
  serviceAccountAnnotations?: Record<string, string>;
  /**
   * VCS provider implementations used to build trigger resources.
   * Defaults to `[new GitHubVcsProvider()]`.
   * Override to add support for other VCS hosts (GitLab, Gitea, etc.).
   */
  providers?: VcsProvider[];
}

/**
 * Top-level orchestrator that synthesizes an entire Tekton project to YAML.
 *
 * Given a set of pipelines, TektonProject:
 * 1. Collects and de-duplicates all tasks across pipelines
 * 2. Synthesizes each task as a separate Tekton Task resource
 * 3. Builds each pipeline with auto-inferred params and workspaces
 * 4. Generates trigger infrastructure (RBAC, EventListener, TriggerBindings/Templates)
 *    for any pipeline associated with a {@link TRIGGER_EVENTS | trigger event}
 * 5. Writes all resources as YAML files to the output directory
 */
export class TektonProject {
  constructor(opts: TektonProjectOptions) {
    const app = new App(opts.outdir ? { outdir: opts.outdir } : undefined);
    const prefix = opts.name ?? '';
    const namespace = opts.namespace;

    // 1. Collect unique Tasks across all pipelines (including finally tasks)
    const uniqueTasks = new Map<string, TaskLike>();
    for (const pipeline of opts.pipelines) {
      for (const task of [...pipeline.allTasks, ...pipeline.finallyTasks]) {
        if (!uniqueTasks.has(task.name)) {
          uniqueTasks.set(task.name, task);
        }
      }
    }

    // 2. Synth each unique Task (non-synthesizable TaskLikes are skipped)
    for (const [name, task] of uniqueTasks) {
      if (!(task instanceof TaskDef)) continue;
      const chart = new Chart(app, prefix ? `${prefix}-task-${name}` : `task-${name}`);
      task.synth(chart, namespace, prefix || undefined, opts.defaultStepSecurityContext);
    }

    // 3. Build each Pipeline
    for (const pipeline of opts.pipelines) {
      const chart = new Chart(app, prefix ? `${prefix}-pipeline-${pipeline.name}` : `pipeline-${pipeline.name}`);
      const extraParams = pipeline.triggers.length > 0
        ? [
            { name: 'project-name', type: 'string' },
            { name: 'repo-full-name', type: 'string' },
          ]
        : [];
      pipeline._build(chart, 'pipeline', namespace, extraParams, prefix || undefined);
    }

    // 4. Create infra chart if any pipeline has triggers
    const pushPipeline = opts.pipelines.find(p =>
      p.triggers.includes(TRIGGER_EVENTS.PUSH),
    );
    const prPipeline = opts.pipelines.find(p =>
      p.triggers.includes(TRIGGER_EVENTS.PULL_REQUEST),
    );
    const tagPipeline = opts.pipelines.find(p =>
      p.triggers.includes(TRIGGER_EVENTS.TAG),
    );

    if (pushPipeline || prPipeline || tagPipeline) {
      const prefixName = (name: string) => prefix ? `${prefix}-${name}` : name;
      new TektonInfraChart(app, prefix ? `${prefix}-tekton-infra` : 'tekton-infra', {
        namespace,
        namePrefix: prefix || undefined,
        pushPipelineRef: pushPipeline ? prefixName(pushPipeline.name) : undefined,
        pullRequestPipelineRef: prPipeline ? prefixName(prPipeline.name) : undefined,
        tagPipelineRef: tagPipeline ? prefixName(tagPipeline.name) : undefined,
        webhookSecretRef: opts.webhookSecretRef,
        urlParam: opts.urlParam,
        revisionParam: opts.revisionParam,
        gitRefParam: opts.gitRefParam,
        workspaceStorageSize: opts.workspaceStorageSize,
        workspaceStorageClass: opts.workspaceStorageClass,
        workspaceAccessModes: opts.workspaceAccessModes,
        defaultPodSecurityContext: opts.defaultPodSecurityContext,
        serviceAccountAnnotations: opts.serviceAccountAnnotations,
        providers: opts.providers,
        // Only PVC-backed caches need PVCs and workspace bindings in the infra chart.
        // GCS caches store archives remotely and don't use PVCs.
        caches: (opts.caches ?? [])
          .filter(c => c.backend?.type !== 'gcs')
          .map(c => ({
            workspaceName: c.workspace.name,
            claimName: c.claimName ?? (prefix ? `${prefix}-${c.workspace.name}` : c.workspace.name),
            storageSize: c.storageSize ?? '1Gi',
            storageClassName: c.storageClassName,
          })),
      });
    }

    // 5. Synth
    app.synth();
  }
}
