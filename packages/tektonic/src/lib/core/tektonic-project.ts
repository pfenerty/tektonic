import * as fs from 'fs';
import * as path from 'path';
import { App, Chart } from 'cdk8s';
import { Pipeline } from './pipeline';
import { TaskLike, TaskDef } from './task';
import type { ImagePullPolicy } from './task';
import { Workspace } from './workspace';
import { DEFAULT_POD_SECURITY_CONTEXT, TEKTON_HOME } from '../constants';
import type { CacheBackend } from './cache-backend';
import type { InjectedStepImage } from './injected-image';
import type { LanguageName } from '../script';
import { diffPaths } from './spec-diff';
import type {
  BuiltPipeline,
  BuiltTask,
  PodEnvVar,
  SynthModel,
  SynthTarget,
} from './synth-target';
import { PacTarget } from '../targets/pac/pac-target';
import type { RepositoryConfig } from '../targets/pac/pac-target';

/**
 * Environment variables the `tektonic` CLI sets on the process that runs a project entrypoint.
 * They exist so `tektonic check` and `tektonic graph` can redirect and inspect a synthesis the
 * consumer's own code drives, without that code knowing anything about the CLI — previously
 * every consumer threaded its own outdir env var through the project definition to make a
 * drift check possible.
 */
export const CLI_ENV = {
  /** Root directory synthesis is redirected under. Each project gets a subdirectory of it. */
  outdir: 'TEKTONIC_OUTDIR',
  /** File the redirect mapping (`{declared, actual}` per project) is appended to as JSON lines. */
  synthManifest: 'TEKTONIC_SYNTH_MANIFEST',
  /** File the pipeline graph is appended to as JSON lines. */
  graphManifest: 'TEKTONIC_GRAPH_MANIFEST',
  /** Comma-separated target names to emit, narrowing what the project declared. */
  targets: 'TEKTONIC_TARGETS',
} as const;

/**
 * The subset of a project's targets the CLI asked for, via `tektonic synth --target <name>`.
 *
 * Narrowing rather than adding: a target emits files a project committed to, so `--target`
 * can only pick from what the entrypoint already declares. Naming one it does not throws
 * rather than emitting nothing, which is what an unnoticed typo would otherwise cost.
 */
function selectedTargets(declared: SynthTarget[]): SynthTarget[] {
  const requested = (process.env[CLI_ENV.targets] ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(name => name.length > 0);
  if (requested.length === 0) return declared;

  const available = declared.map(t => t.name);
  const missing = requested.filter(name => !available.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `tektonic: --target ${missing.map(m => `'${m}'`).join(', ')} — this project declares ` +
        `[${available.join(', ')}]. Add the target to 'targets' in the project definition, ` +
        `or name one of those.`,
    );
  }
  return declared.filter(t => requested.includes(t.name));
}

/**
 * The directory a project actually writes to. Unchanged unless the CLI asked for a redirect,
 * in which case the declared path becomes a subdirectory of the redirect root — flattened, so
 * an outdir outside the repo (`../.tekton`) cannot escape it — and the mapping is recorded for
 * the CLI to diff against.
 */
function redirectedOutdir(declared: string): string {
  const root = process.env[CLI_ENV.outdir];
  if (!root) return declared;
  const actual = path.join(root, declared.replace(/[^A-Za-z0-9._-]+/g, '_') || 'out');
  const manifest = process.env[CLI_ENV.synthManifest];
  if (manifest) fs.appendFileSync(manifest, `${JSON.stringify({ declared, actual })}\n`);
  return actual;
}

/** One task node in a {@link PipelineGraph}, as rendered by `tektonic graph`. */
export interface GraphNode {
  name: string;
  runAfter: string[];
  /** True when the task carries a `when` guard, so the graph can mark it conditional. */
  gated: boolean;
}

/** One pipeline's shape, emitted for the CLI's `graph` command. */
export interface PipelineGraph {
  name: string;
  events: string[];
  timeout?: string;
  tasks: GraphNode[];
  finally: GraphNode[];
}

/** Reduces built pipeline task specs to the fields `tektonic graph` renders. */
function graphNodes(specs: unknown): GraphNode[] {
  if (!Array.isArray(specs)) return [];
  return (specs as Record<string, unknown>[]).map(t => ({
    name: String(t.name),
    runAfter: Array.isArray(t.runAfter) ? (t.runAfter as string[]) : [],
    gated: Array.isArray(t.when) && t.when.length > 0,
  }));
}

/**
 * Specifies a persistent cache volume bound into every run. The generated PVC persists
 * across runs so tools can reuse cached data (a vulnerability database, dependencies,
 * build artifacts).
 */
export interface CacheSpec {
  /** The workspace bound to the persistent volume across runs. */
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
   * Cache storage backend. A backend whose `needsPvcWorkspace` is false — anything
   * storing archives remotely — binds no PVC for this cache.
   */
  backend?: CacheBackend;
}

/** Options for {@link TektonicProject}. */
export interface TektonicProjectOptions {
  /**
   * Generate a PAC `Repository` custom resource linking this repo to the namespace
   * (and, optionally, a git provider). Omit to manage the `Repository` yourself.
   *
   * Configures the default {@link PacTarget}; ignored when {@link targets} replaces it.
   */
  repository?: RepositoryConfig;
  /** Optional name prefix applied to all generated resource names. */
  name?: string;
  /** Kubernetes namespace for task and run resources. */
  namespace: string;
  /** Pipelines to synthesize. */
  pipelines: Pipeline[];
  /** Persistent cache volumes to bind in every run. */
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
   *
   * Configures the default {@link PacTarget}; ignored when {@link targets} replaces it.
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
   * for every run pod.
   */
  defaultPodSecurityContext?: Record<string, unknown>;
  /**
   * Container-level security context merged on top of `DEFAULT_STEP_SECURITY_CONTEXT`
   * for every task's stepTemplate.
   */
  defaultStepSecurityContext?: Record<string, unknown>;
  /**
   * Image pull policy written into every task's `stepTemplate`, covering the injected
   * cache and reporter steps as well as the user's own. A task's `stepTemplate` or an
   * individual step's `imagePullPolicy` overrides it.
   *
   * Set `'Always'` when steps reference images by mutable tag: the kubelet defaults to
   * `IfNotPresent` for every tag but `:latest`, so a republished tag is served from the
   * node's image cache indefinitely, with no signal.
   *
   * Tekton applies `stepTemplate` to steps only — sidecars need their own
   * `imagePullPolicy` on `TaskSidecarSpec`.
   */
  defaultImagePullPolicy?: ImagePullPolicy;
  /**
   * Image for the steps tektonic injects — git clone, cache restore/save, status
   * reporting, change detection. Tektonic ships no image: it generates each injected
   * script and only expects the image to *provide* what that script invokes.
   *
   * Every injected step resolves its image the same way: the step's own
   * (`TaskCacheSpec.image`, `GitPipelineOptions.cloneImage`, a reporter's or backend's
   * `image`) → the component's default, when it has one → this → tektonic's neutral
   * fallback, {@link DEFAULT_INJECTED_STEP_IMAGE}.
   *
   * The fallback provides `sh` and `git` only, so features needing more — compressed
   * caches, GCS caches, the built-in status reporter (`nushell`, `tar`, `zstd`,
   * `gcloud`) — fail at synth time naming the capability, rather than at pod-run time
   * with `command not found`. Name an image that has them:
   *
   * ```ts
   * injectedStepImage: DEFAULT_BASE_IMAGE               // the pre-v2.1 default, opted into
   * injectedStepImage: 'ghcr.io/acme/ci-base:1.4.0'     // trusted for every capability
   * injectedStepImage: { image: 'ghcr.io/acme/ci-base:1.4.0', provides: ['sh', 'git'] }
   * ```
   *
   * A bare string is taken at its word — synthesis is offline and never probes a
   * registry. The object form declares what the image actually has, and is checked.
   */
  injectedStepImage?: InjectedStepImage;
  /**
   * Emit TEP-0147 artifact provenance for every task that declares `produces` or `consumes`.
   *
   * Off by default, and deliberately so: the upstream feature is alpha and only does anything
   * on a cluster whose `feature-flags` ConfigMap sets `enable-artifacts: "true"`. Turning it
   * on elsewhere adds a step per artifact-using task whose output no controller reads.
   *
   * What it produces is metadata for Tekton Chains — `{uri, digest}` records saying what each
   * task read and wrote — not transport. Bytes move through the task's `artifactStore`, which
   * is a separate choice. Mark the artifacts that are *subjects* of the build with
   * `buildOutput` in their own declaration; everything else is recorded as a byproduct.
   *
   * A task overrides this with its own `artifactProvenance`.
   */
  artifactProvenance?: boolean;
  /**
   * Default scripting language for steps whose `script` is a bare body (a
   * `{ language, body }` object or a raw string without a shebang). Individual
   * tasks override via their own `defaultLanguage`; tagged bodies always win.
   */
  defaultLanguage?: LanguageName;
  /** Service account name for run pods. Defaults to `"tekton-triggers"`. */
  serviceAccountName?: string;
  /**
   * Maximum number of completed PipelineRuns to retain per repository.
   * PAC deletes older runs once this limit is exceeded. Defaults to `5`.
   *
   * Configures the default {@link PacTarget}; ignored when {@link targets} replaces it.
   */
  maxKeepRuns?: number;
  /**
   * Additional environment variables injected into every step of every task via
   * `taskRunTemplate.podTemplate.env`. Applied to all TaskRun pods in all runs.
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
  podTemplateEnv?: PodEnvVar[];
  /**
   * Inject the PAC event context — event type, branches, revision, repo — into every step as
   * environment variables, under the stable names the PAC target defines.
   *
   * Use it where the *event* rather than the code decides what a step does: a scan that runs
   * diff-scoped on a pull request and full on a push, for instance. Without it, that meant
   * knowing which PAC template variables exist, that PAC substitutes them before submission,
   * and that `podTemplateEnv` is where they go. An entry of the same name in
   * `podTemplateEnv` wins.
   *
   * Defaults to `false`. Configures the default {@link PacTarget}; ignored when
   * {@link targets} replaces it.
   */
  pacEventContext?: boolean;
  /**
   * Annotations merged into every generated run's metadata, alongside the target's own.
   * Use for Tekton Chains controls such as `chains.tekton.dev/transparency-upload`.
   */
  pipelineRunAnnotations?: Record<string, string>;
  /**
   * Synthesis targets that emit this project. Defaults to a single {@link PacTarget}
   * configured from the PAC options above.
   *
   * Passing this **replaces** the default target, so include a `new PacTarget({ … })` of
   * your own to keep emitting PAC alongside anything else. Targets share the outdir and own
   * the file names they write.
   */
  targets?: SynthTarget[];
}

/**
 * Synthesizes a Tektonic project: builds the provider-neutral {@link SynthModel} — pipeline
 * specs, task manifests, workspace bindings, run defaults — and hands it to each
 * {@link SynthTarget} to emit.
 *
 * The default target is {@link PacTarget}, which writes Tekton Pipelines as Code YAML: a PAC-annotated
 * `PipelineRun` template per triggered pipeline in `<outdir>/`, one `Task` file per unique
 * task in `<outdir>/tasks/`, and an optional `Repository` custom resource. Pass
 * {@link TektonicProjectOptions.targets | targets} to emit something else — plain Tekton via
 * `TektonTarget`, or any third-party target.
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
  /** The provider-neutral model handed to every target. */
  readonly model: SynthModel;
  /** The targets that emitted this project, in the order they ran. */
  readonly targets: SynthTarget[];

  constructor(opts: TektonicProjectOptions) {
    // The declared outdir stays the source of truth for `repoRelativePath`: a redirected
    // synthesis must emit byte-identical YAML, or a drift check would compare against
    // annotations that name the temp directory.
    const declaredOutdir = opts.outdir ?? '.tekton';
    const outdir = redirectedOutdir(declaredOutdir);
    const prefix = opts.name ?? '';
    const namespace = opts.namespace;

    const declaredTargets = opts.targets ?? [
      new PacTarget({
        repository: opts.repository,
        repoRelativePath: opts.repoRelativePath ?? declaredOutdir,
        maxKeepRuns: opts.maxKeepRuns,
        eventContext: opts.pacEventContext,
      }),
    ];
    if (opts.targets) warnUnusedPacOptions(opts, declaredTargets);
    // `--target` narrows what this run emits, so everything downstream — injected params and
    // env included — is built from the selected targets, not the declared ones.
    this.targets = selectedTargets(declaredTargets);

    const podSecurityContext = {
      ...DEFAULT_POD_SECURITY_CONTEXT,
      ...(opts.defaultPodSecurityContext ?? {}),
    };

    // Env comes from three places, in precedence order: the project's own entries win over
    // anything a target contributes, and HOME is the framework's last-resort default.
    const podTemplateEnv = [...(opts.podTemplateEnv ?? [])];
    const hasEnv = (name: string): boolean => podTemplateEnv.some(e => e.name === name);
    for (const target of this.targets) {
      for (const entry of target.injectedEnv ?? []) {
        if (!hasEnv(entry.name)) podTemplateEnv.push(entry);
      }
    }
    // A pod-level runAsUser (set by default) normally has no /etc/passwd entry, so $HOME
    // resolves to '/', which Tekton's creds-init cannot write to — taking git and registry
    // credentials with it. /tekton/home is the writable directory Tekton mounts for this.
    if ('runAsUser' in podSecurityContext && !hasEnv('HOME')) {
      podTemplateEnv.push({ name: 'HOME', value: TEKTON_HOME });
    }

    // Which caches need a PVC is the backend's own answer, read off the interface. This
    // used to string-match `type === 'gcs'`, which bound a pointless PVC for every
    // out-of-tree remote backend — the built-ins were the only ones anyone had tried.
    const pvcCaches = (opts.caches ?? []).filter(c => c.backend?.needsPvcWorkspace ?? true);

    // Every task is emitted once, keyed by name, and every pipeline references it by that
    // name — so two distinct tasks sharing a name must declare the same thing, or one
    // pipeline would run a manifest it never declared. GitPipeline makes this easy to hit:
    // each one generates its own git-clone, and a differing cloneDepth used to vanish.
    const renderTask = (task: TaskDef): Record<string, unknown> => {
      const chart = new Chart(new App(), task.name);
      task.synth(chart, namespace, {
        namePrefix: prefix || undefined,
        stepSecurityContext: opts.defaultStepSecurityContext,
        defaultLanguage: opts.defaultLanguage,
        defaultImagePullPolicy: opts.defaultImagePullPolicy,
        injectedStepImage: opts.injectedStepImage,
        artifactProvenance: opts.artifactProvenance,
      });
      return chart.toJson()[0] as Record<string, unknown>;
    };

    // 1. Collect unique tasks across all pipelines (including finally tasks)
    const uniqueTasks = new Map<string, TaskLike>();
    const declaringPipeline = new Map<string, string>();
    for (const pipeline of opts.pipelines) {
      for (const task of [...pipeline.allTasks, ...pipeline.finallyTasks]) {
        const existing = uniqueTasks.get(task.name);
        if (existing === undefined) {
          uniqueTasks.set(task.name, task);
          declaringPipeline.set(task.name, pipeline.name);
          continue;
        }
        if (existing === task) continue;
        if (!(existing instanceof TaskDef) || !(task instanceof TaskDef)) continue;
        const differences = diffPaths(renderTask(existing), renderTask(task));
        if (differences.length === 0) continue;
        const emittedName = prefix ? `${prefix}-${task.name}` : task.name;
        throw new Error(
          `TektonicProject: task '${task.name}' is declared differently in pipelines ` +
            `'${declaringPipeline.get(task.name)}' and '${pipeline.name}', but both are emitted as a ` +
            `single Task '${emittedName}' — one pipeline would run a manifest it did not declare. ` +
            `Differing fields: ${differences.join(', ')}. ` +
            `Give the tasks distinct names, or make the two declarations identical.`,
        );
      }
    }

    // 2. Render each unique task once. A TaskLike that is not a TaskDef (a HubTaskRef, say)
    //    resolves to a task someone else published, so there is nothing to emit for it.
    const tasks: BuiltTask[] = [];
    for (const [name, task] of uniqueTasks) {
      if (!(task instanceof TaskDef)) continue;
      tasks.push({
        name,
        resourceName: prefix ? `${prefix}-${name}` : name,
        manifest: renderTask(task),
        ...(task.catalog ? { catalog: task.catalog } : {}),
      });
    }

    // 3. Build one spec per pipeline, with every target's injected params declared on it.
    const injectedParams = dedupeByName(this.targets.flatMap(t => t.injectedParams ?? [])).map(p =>
      p.toSpec(),
    );
    const cacheWorkspaceNames = new Set(pvcCaches.map(c => c.workspace.name));
    const pipelines: BuiltPipeline[] = opts.pipelines.map(pipeline => {
      const spec = pipeline._buildSpec(injectedParams, prefix || undefined);

      // Workspace bindings: cache workspaces → PVCs, all others → ephemeral volumeClaimTemplate
      const specWorkspaces = (spec.workspaces ?? []) as Array<{ name: string }>;
      const workspaceBindings = specWorkspaces.map(w => {
        if (cacheWorkspaceNames.has(w.name)) {
          const cacheSpec = pvcCaches.find(c => c.workspace.name === w.name)!;
          const claimName = cacheSpec.claimName ?? (prefix ? `${prefix}-${w.name}` : w.name);
          return { name: w.name, persistentVolumeClaim: { claimName } };
        }
        return {
          name: w.name,
          volumeClaimTemplate: {
            spec: {
              accessModes: opts.workspaceAccessModes ?? ['ReadWriteOnce'],
              ...(opts.workspaceStorageClass
                ? { storageClassName: opts.workspaceStorageClass }
                : {}),
              resources: { requests: { storage: opts.workspaceStorageSize ?? '1Gi' } },
            },
          },
        };
      });

      return {
        name: pipeline.name,
        resourceName: prefix ? `${prefix}-${pipeline.name}` : pipeline.name,
        spec,
        ...(pipeline.timeout ? { timeout: pipeline.timeout } : {}),
        events: [...pipeline.events],
        ...(pipeline.trigger ? { trigger: pipeline.trigger } : {}),
        workspaceBindings,
      };
    });

    this.model = {
      ...(prefix ? { name: prefix } : {}),
      namespace,
      pipelines,
      tasks,
      defaults: {
        serviceAccountName: opts.serviceAccountName ?? 'tekton-triggers',
        podSecurityContext,
        podTemplateEnv,
        runAnnotations: opts.pipelineRunAnnotations ?? {},
      },
    };

    // 4. The CLI's drift/graph manifests are a CLI concern, not a target's — every target
    //    would otherwise reimplement them.
    const graphManifest = process.env[CLI_ENV.graphManifest];
    if (graphManifest) {
      const graph: PipelineGraph[] = pipelines
        .filter(p => p.trigger && p.events.length > 0)
        .map(p => ({
          name: p.name,
          events: [...p.events],
          ...(p.timeout ? { timeout: p.timeout } : {}),
          tasks: graphNodes(p.spec.tasks),
          finally: graphNodes(p.spec.finally),
        }));
      fs.appendFileSync(
        graphManifest,
        `${JSON.stringify({ project: prefix || undefined, outdir: declaredOutdir, pipelines: graph })}\n`,
      );
    }

    for (const target of this.targets) target.emit(this.model, outdir);
  }
}

/** First occurrence of each name, preserving order. */
function dedupeByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(item.name)) seen.set(item.name, item);
  return [...seen.values()];
}

/**
 * Warns when a PAC-only option is set but no PAC target is emitting — the option would
 * silently do nothing, and a `Repository` CR quietly not being written is the kind of thing
 * you find out about from the cluster.
 */
function warnUnusedPacOptions(opts: TektonicProjectOptions, targets: SynthTarget[]): void {
  if (targets.some(t => t instanceof PacTarget)) return;
  const unused = (
    [
      ['repository', opts.repository],
      ['repoRelativePath', opts.repoRelativePath],
      ['maxKeepRuns', opts.maxKeepRuns],
      ['pacEventContext', opts.pacEventContext],
    ] as const
  )
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name);
  if (unused.length === 0) return;
  // eslint-disable-next-line no-console
  console.warn(
    `tektonic: ${unused.join(', ')} configure the default PAC target, but 'targets' replaced it ` +
      `with [${targets.map(t => t.name).join(', ')}] — pass 'new PacTarget({ … })' in 'targets' ` +
      `to keep emitting PAC.`,
  );
}
