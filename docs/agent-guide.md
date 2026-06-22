# Tektonic Agent Guide

A complete reference for agents creating Tekton CI/CD pipelines with this library.

## Mental Model

- **`Param` / `Workspace`** are named handles. Use them in template literals (`${param}`, `${workspace.path}`) to produce Tekton interpolation expressions (`$(params.name)`, `$(workspaces.name.path)`).
- **`Task`** maps to one Tekton Task: a list of steps, optional params/workspaces, optional caches, and an optional status reporter.
- **Step scripts** are typed: author them with the `sh`/`bash`/`nu`/`py` tagged templates or load a real file with `scriptFromFile`. The framework owns the exit-code/status plumbing. See [scripting.md](scripting.md).
- **`GitPipeline`** wires tasks together: it auto-creates a `git-clone` step, threads the shared workspace through every task, and walks the `needs` graph to set `runAfter`. `TRIGGER_EVENTS` controls which GitHub events fire it.
- **`TektonProject`** is the synthesizer for cluster-deployed pipelines + triggers. Calling `new TektonProject(...)` writes all Kubernetes manifests (Tasks, Pipeline, RBAC, EventListener, TriggerBindings/Templates, PVCs) to `outdir`. **`PACProject`** is the alternative synthesizer for [Pipelines as Code](pac.md) (in-repo `.tekton/` PipelineRun templates).

## Installation

```bash
npm install @pfenerty/tektonic cdk8s constructs
```

Create a pipeline file (e.g. `ci/pipeline.ts`) and run it:

```bash
npx ts-node ci/pipeline.ts
# or add to package.json: "synth": "ts-node ci/pipeline.ts"
```

## Minimal Example

```typescript
import {
  Task,
  GitPipeline,
  TektonProject,
  TRIGGER_EVENTS,
  sh,
} from '@pfenerty/tektonic';

// One task: run tests
const test = new Task({
  name: 'test',
  steps: [{
    name: 'test',
    image: 'node:22-alpine',
    // workingDir defaults to the shared workspace path (set by GitPipeline)
    script: sh`npm ci && npm test`,
  }],
});

// One pipeline: fire on push, run the test task
// GitPipeline auto-creates a git-clone step that runs first
const pipeline = new GitPipeline({
  name: 'push',
  triggers: [TRIGGER_EVENTS.PUSH],
  tasks: [test],
});

// Synthesize everything to YAML
new TektonProject({
  name: 'my-app',         // prefix for all resource names
  namespace: 'tekton-ci', // Kubernetes namespace
  pipelines: [pipeline],
  outdir: '.tekton',      // output directory
  webhookSecretRef: {     // Kubernetes Secret for GitHub webhook validation
    secretName: 'github-webhook-secret',
    secretKey: 'secret',
  },
});
```

## Param

```typescript
import { Param } from '@pfenerty/tektonic';

const ref = new Param({ name: 'ref', type: 'string' });

// Use in a step script via template literal:
script: `git checkout ${ref}`  // → "git checkout $(params.ref)"
```

**Options:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Parameter name in Tekton manifests |
| `type?` | `'string' \| 'array' \| 'object'` | Defaults to `'string'` |
| `description?` | `string` | Human-readable description |
| `default?` | `string \| string[]` | Default value when not supplied |
| `pipelineExpression?` | `string` | Override the default `$(params.name)` expression (e.g. `$(tasks.status)` for built-ins) |

Params declared on a task are automatically collected and surfaced at the pipeline level. You don't need to declare them on the pipeline.

## Workspace

```typescript
import { Workspace } from '@pfenerty/tektonic';

const ws = new Workspace({ name: 'source' });

workingDir: ws.path   // → "$(workspaces.source.path)"
script: `ls ${ws.path}`  // → "ls $(workspaces.source.path)"
```

**Options:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Workspace name in Tekton manifests |
| `description?` | `string` | Human-readable description |
| `optional?` | `boolean` | Defaults to `false` |

`GitPipeline` auto-creates a `workspace` workspace and mounts it on every task. You rarely need to declare workspaces explicitly unless adding a second one (e.g. a dedicated cache PVC).

## Task

```typescript
const task = new Task({
  name: 'build',
  params: [refParam],           // Params this task accepts
  workspaces: [extraWorkspace], // Additional workspaces (workspace is auto-added by GitPipeline)
  needs: [testTask],            // Tasks that must complete first
  statusReporter,               // Optional: report status to GitHub
  caches: [...],                // Optional: inject restore/save steps (see Caching)
  stepTemplate: {               // Override step defaults (merged with security context defaults)
    resources: { requests: { memory: '512Mi' } },
  },
  steps: [
    {
      name: 'build',
      image: 'golang:1.22-alpine',
      script: sh`go build ./...`,   // or scriptFromFile(...) — see scripting.md
      env: [
        { name: 'GOOS', value: 'linux' },
        // Secret reference:
        { name: 'TOKEN', valueFrom: { secretKeyRef: { name: 'my-secret', key: 'token' } } },
      ],
      onError: 'continue',       // 'continue' or 'stopAndFail' (default)
      computeResources: {
        requests: { cpu: '500m', memory: '1Gi' },
        limits: { memory: '2Gi' },
      },
      // volumeMounts: mount a task `volumes` entry (e.g. a secret) into the step
      // volumeMounts: [{ name: 'docker-config', mountPath: '/cfg', readOnly: true }],
    },
  ],
});
```

**Key behaviors:**
- Steps run in order. If a step fails and `onError` is not `'continue'`, the task stops.
- `needs` drives the pipeline dependency graph — tasks without `needs` run after git-clone.
- The status reporter appends a final reporting step automatically at synthesis time.

## GitPipeline

```typescript
import { GitPipeline, TRIGGER_EVENTS } from '@pfenerty/tektonic';

const pipeline = new GitPipeline({
  name: 'my-pipeline',
  triggers: [TRIGGER_EVENTS.PUSH, TRIGGER_EVENTS.PULL_REQUEST],
  tasks: [testTask, buildTask, scanTask],  // order doesn't matter; needs drives sequencing
  cloneImage: 'ghcr.io/myorg/git:latest', // optional: override default clone image
  cloneDepth: 'full',                      // optional: full history (default 1 = shallow);
                                           // use 'full' when steps need tag history (e.g. changelogs)
});
```

**Auto-injected params** (available in all task scripts):
- `$(params.url)` — repository clone URL
- `$(params.revision)` — commit SHA
- `$(params.repo-full-name)` — `owner/repo` (added when using `GitHubStatusReporter`)

**Trigger events:**

| Constant | GitHub event |
|----------|-------------|
| `TRIGGER_EVENTS.PUSH` | Push to any branch |
| `TRIGGER_EVENTS.PULL_REQUEST` | PR opened/synchronized |
| `TRIGGER_EVENTS.TAG` | Tag push |

## TektonProject

```typescript
new TektonProject({
  name: 'my-app',           // Resource name prefix
  namespace: 'tekton-ci',   // Kubernetes namespace
  pipelines: [pipeline],
  outdir: '.tekton',

  // GitHub webhook validation
  webhookSecretRef: {
    secretName: 'github-webhook-secret',
    secretKey: 'secret',
  },

  // Ephemeral workspace PVC (created fresh each PipelineRun)
  workspaceStorageSize: '3Gi',         // default: '1Gi'
  workspaceStorageClass: 'standard',   // omit to use cluster default
  workspaceAccessModes: ['ReadWriteOnce'], // default

  // Persistent cache PVCs (PVC backend only — not needed for GCS)
  caches: [
    { workspace: cacheWorkspace, storageSize: '5Gi', storageClassName: 'standard' },
  ],

  // Pipeline param names (match what you declare in your pipelines)
  urlParam: 'url',          // default
  revisionParam: 'revision', // default
  gitRefParam: 'ref',       // optional — add if tasks need the branch ref

  // GKE Workload Identity binding for the triggers ServiceAccount
  serviceAccountAnnotations: {
    'iam.gke.io/gcp-service-account': 'tekton-ci@my-project.iam.gserviceaccount.com',
  },

  // Security context overrides
  defaultPodSecurityContext: { fsGroup: 1000 },
  defaultStepSecurityContext: { runAsUser: 1000 },
});
```

**What gets generated** in `outdir`:
- One `Task` manifest per task
- One `Pipeline` manifest per `GitPipeline`
- `EventListener`, `TriggerBinding`, `TriggerTemplate` per trigger
- RBAC (`ServiceAccount`, `ClusterRole`, `ClusterRoleBinding`)
- `PersistentVolumeClaim` for each `caches` entry (not for GCS backends)
- `kustomization.yaml` listing all manifests

## PACProject

If your cluster runs [Pipelines as Code](https://pipelinesascode.tekton.dev/), use `PACProject`
instead of `TektonProject`. It emits in-repo `.tekton/` PipelineRun templates (read from the
pushed commit) and per-task files, binding well-known params (`url`, `revision`,
`repo-full-name`, `source-branch`) to PAC `{{ }}` variables — no EventListener or RBAC needed.
The pipeline/task model is identical; only the synthesizer changes. See [pac.md](pac.md).

## Caching

Caches inject a restore step before your steps and a save step after. Hit/miss is hash-based (SHA256 of the key files), matching GitLab CI's `cache:` keyword behavior.

### GCS backend (GKE + Workload Identity)

No PVC needed. Archives stored in a GCS bucket. Requires Workload Identity on GKE.

```typescript
caches: [{
  name: 'npm',                          // used in step names: restore-npm-cache / save-npm-cache
  key: ['package-lock.json'],           // files whose content determines the cache key
  paths: ['node_modules'],              // directories to restore/save
  backend: { type: 'gcs', bucket: 'my-ci-cache', prefix: 'npm/' },
  compress: true,                       // zstd compression (recommended for GCS)
  workingDir: '$(workspaces.workspace.path)',
}]
// No CacheSpec entry needed in TektonProject
// Set serviceAccountAnnotations on TektonProject for Workload Identity
```

### PVC backend (homelab / NFS)

Archives stored on a PersistentVolumeClaim. Declare the workspace and register it in `TektonProject.caches`.

```typescript
const npmCache = new Workspace({ name: 'npm-cache' });

// In Task:
caches: [{
  name: 'npm',
  key: ['package-lock.json'],
  paths: ['node_modules'],
  workspace: npmCache,
  compress: true,
  workingDir: '$(workspaces.workspace.path)',
}]

// In TektonProject:
caches: [{ workspace: npmCache, storageSize: '5Gi' }]
```

### Cache options

| Field | Default | Description |
|-------|---------|-------------|
| `name` | required | Step name prefix (`restore-{name}-cache`) |
| `key` | required | Key files; `[]` = fixed hash (always hits after first run) |
| `paths` | required | Paths to cache relative to `workingDir` |
| `backend` | PVC | `{ type: 'gcs', bucket, prefix? }` for GCS |
| `workspace` | — | Required for PVC backend |
| `compress` | `false` | zstd compression into `.tar.zst` archive |
| `compressionLevel` | `1` | zstd level 1–19 |
| `multiThreadCompression` | auto | `true` for GCS, `false` for PVC |
| `maxEntries` | `3` | Max archives to keep; `0` disables eviction |
| `forceSave` | `false` | Always save even if archive exists (use for tool-managed DBs like grype) |
| `saveStrategy` | `'step'` | `'finally'` runs save in a separate pod after the build pod exits |
| `workingDir` | — | Paths are relative to this dir |

## GitHub Status Reporting

```typescript
import { GitHubStatusReporter } from '@pfenerty/tektonic';

const reporter = new GitHubStatusReporter();
// optional: new GitHubStatusReporter({ tokenSecretName: 'my-secret' })

const task = new Task({
  name: 'test',
  statusReporter: reporter,
  // statusContext: 'ci/test', // defaults to task name
  steps: [...],
});
```

The reporter appends a final step that calls the GitHub Commit Status API. It requires:
- A Kubernetes Secret named `github-token` with key `token` containing a GitHub token with `repo:status` scope
- `repo-full-name` and `revision` params — auto-injected by `GitHubStatusReporter` into any task that uses it

## Result

Tasks can declare typed results that downstream tasks (or the pipeline itself) reference via Tekton interpolation expressions.

```typescript
import { Result } from '@pfenerty/tektonic';

const commit = new Result({ name: 'commit', description: 'Full commit SHA' });
const branch = new Result({ name: 'branch' });

const cloneTask = new Task({
  name: 'git-clone',
  results: [commit, branch],
  steps: [{
    name: 'clone',
    image: 'alpine/git',
    script: `#!/bin/sh
git clone ... && git rev-parse HEAD | tee ${commit.path}`,
  }],
});

// In a downstream task, interpolate results:
const buildTask = new Task({
  name: 'build',
  needs: [cloneTask],
  steps: [{
    name: 'build',
    image: 'node:22',
    script: `#!/bin/sh
echo "Building commit ${commit}"`,
    // commit.toString() → "$(tasks.git-clone.results.commit)"
  }],
});
```

**Result options:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Result name in Tekton manifests |
| `description?` | `string` | Human-readable description |

**Key properties:**
- `result.path` — path to write the result value: `$(results.<name>.path)`
- `result.toString()` — pipeline-level reference: `$(tasks.<taskName>.results.<name>)`

`GitPipeline` pre-declares results for the built-in git-clone task: `commit`, `short-sha`, `branch`, `commit-message`, `author-name`, `author-email`, `timestamp`, `remote-url`.

---

## HubTaskRef

`HubTaskRef` lets you reference a Tekton Task published on [ArtifactHub](https://artifacthub.io/packages/search?kind=7) without writing a local Task definition. The resolver-based `taskRef` is synthesized automatically.

```typescript
import { HubTaskRef } from '@pfenerty/tektonic';

const gitClone = new HubTaskRef({
  taskName: 'git-clone',
  version: '0.9',
  params: [urlParam, revParam],
  workspaces: [workspace],
});

// Use like any other task in needs/pipeline:
const build = new Task({
  name: 'build',
  needs: [gitClone],
  steps: [...],
});

const pipeline = new Pipeline({ name: 'ci', tasks: [build] });
```

`HubTaskRef` implements `TaskLike` — it participates in the dependency graph, declares its params/workspaces for inference, but produces no `Task` manifest (it references an externally published one).

**HubTaskRef options:**

| Field | Type | Description |
|-------|------|-------------|
| `taskName` | `string` | Name of the published Task on ArtifactHub |
| `version` | `string` | Task version string (e.g. `"0.9"`) |
| `params?` | `Param[]` | Params the task accepts (used for pipeline-level inference) |
| `workspaces?` | `Workspace[]` | Workspaces the task requires |
| `needs?` | `TaskLike[]` | Upstream dependencies |
| `catalog?` | `string` | ArtifactHub catalog name. Defaults to `"tekton"` |

---

## Conditional Tasks (gated)

`gated()` wraps a task with per-pipeline-edge overrides — `when` expressions, retry counts, and timeouts. The same task instance can be conditional in one pipeline and unconditional in another.

```typescript
import { gated } from '@pfenerty/tektonic';

const pipeline = new Pipeline({
  tasks: [
    clone,
    // build only runs on push events, retried up to 2 times, with a 30-minute cap
    gated(build, {
      when: [{ input: '$(params.event-type)', operator: 'in', values: ['push'] }],
      retries: 2,
      timeout: '30m',
    }),
  ],
});
```

Overrides are applied at pipeline-spec time only — the underlying `Task` manifest is unchanged.

**PipelineTaskOverrides:**

| Field | Type | Description |
|-------|------|-------------|
| `when?` | `WhenExpression[]` | Conditional expressions — all must match for the task to run |
| `retries?` | `number` | Retry count on failure |
| `timeout?` | `string` | Max duration as a Go duration string (e.g. `"10m"`, `"1h30m"`) |

**WhenExpression:**

| Field | Type | Description |
|-------|------|-------------|
| `input` | `string` | Pipeline expression to evaluate (e.g. `"$(params.type)"`) |
| `operator` | `'in' \| 'notin'` | Comparison operator |
| `values` | `string[]` | Values to match against |

---

## Sidecars and Volumes

Tasks can declare sidecar containers (run alongside steps for the task pod's lifetime) and additional volumes (available for mounting in steps and sidecars).

```typescript
const dbTest = new Task({
  name: 'db-test',
  // shared emptyDir volume between step and sidecar
  volumes: [{ name: 'tmp', emptyDir: {} }],
  sidecars: [{
    name: 'postgres',
    image: 'postgres:16-alpine',
    env: [
      { name: 'POSTGRES_DB', value: 'testdb' },
      { name: 'POSTGRES_PASSWORD', value: 'test' },
    ],
    readinessProbe: {
      exec: { command: ['pg_isready', '-U', 'postgres'] },
      initialDelaySeconds: 5,
    },
  }],
  steps: [{
    name: 'test',
    image: 'node:22-alpine',
    env: [{ name: 'DATABASE_URL', value: 'postgres://postgres:test@localhost/testdb' }],
    script: '#!/bin/sh\nnpm test',
  }],
});
```

**Sidecar options** (`TaskSidecarSpec`) — mirrors step fields minus `onError`:

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Sidecar name (unique within the task) |
| `image` | `string` | Container image |
| `command?` | `string[]` | Entrypoint override |
| `args?` | `string[]` | Arguments |
| `script?` | `string` | Inline script |
| `workingDir?` | `string` | Working directory |
| `env?` | `EnvSpec[]` | Environment variables |
| `computeResources?` | `ResourceSpec` | CPU/memory requests and limits |
| `securityContext?` | `object` | Per-container security context |
| `readinessProbe?` | `object` | Kubernetes readiness probe (Tekton waits for this before starting steps) |

**Volume spec** (`TaskVolumeSpec`) — follows the Kubernetes `v1.Volume` schema, `name` is required:

```typescript
{ name: 'shared', emptyDir: {} }
{ name: 'config', configMap: { name: 'my-config' } }
{ name: 'certs', secret: { secretName: 'tls-certs' } }
```

---

## VcsProvider

`VcsProvider` is a pluggable interface for generating Tekton trigger resources. The default is `GitHubVcsProvider`. Override via `TektonProject.providers` to add support for GitLab, Gitea, or other VCS hosts without modifying the library.

```typescript
import { GitHubVcsProvider } from '@pfenerty/tektonic';

// Default (GitHub) — explicit form:
new TektonProject({
  providers: [new GitHubVcsProvider()],
  // ... rest of options
});

// Custom provider — implement VcsProvider:
class MyGitLabProvider implements VcsProvider {
  readonly supportedEvents = [TRIGGER_EVENTS.PUSH, TRIGGER_EVENTS.PULL_REQUEST];

  buildTrigger(scope, pipelineRef, event, ctx): VcsTriggerContribution {
    // Create TriggerBinding + TriggerTemplate ApiObjects under `scope`
    // Return the EventListener trigger entry
    ...
  }
}

new TektonProject({
  providers: [new MyGitLabProvider()],
  // ...
});
```

`VcsProviderCtx` carries all project-level settings (namespace, namePrefix, webhookSecretRef, workspace storage, etc.) plus `allEvents` — the full list of configured events, used for cross-event CEL filtering (e.g. excluding tag pushes from the push trigger when a tag pipeline is also configured).

---

## Real-World Example

The following is the actual self-CI pipeline for this repository. It shows:
- Multiple tasks with GCS caching
- Task dependencies (`needs`)
- GitHub status reporting
- SARIF upload to GitHub Advanced Security
- Multiple pipelines (push vs. pull request) sharing tasks

> The scripts below use the legacy raw-shebang form with manual exit-code plumbing. New code
> should use the [script API](scripting.md) (`sh`/`nu`/`scriptFromFile`), which captures exit
> codes automatically — see the note above.

```typescript
import {
    Param,
    Task,
    GitPipeline,
    TektonProject,
    TRIGGER_EVENTS,
    GitHubStatusReporter,
    DEFAULT_BASE_IMAGE,
} from '@pfenerty/tektonic';

const nodeImage = 'ghcr.io/pfenerty/apko-cicd/nodejs:22';
const syftImage = 'ghcr.io/pfenerty/apko-cicd/syft:1.42.3';
const grypeImage = 'ghcr.io/pfenerty/apko-cicd/grype:0.110.0';

const refParam = new Param({ name: 'ref', type: 'string' });
const statusReporter = new GitHubStatusReporter();
const gcsBucket = 'my-ci-cache';

const npmTest = new Task({
    name: 'test-npm',
    statusReporter,
    caches: [{
        name: 'npm',
        key: ['package-lock.json'],
        paths: ['node_modules'],
        backend: { type: 'gcs', bucket: gcsBucket, prefix: 'npm/' },
        compress: true,
        workingDir: '$(workspaces.workspace.path)',
    }],
    steps: [{
        name: 'test',
        image: nodeImage,
        workingDir: '$(workspaces.workspace.path)',
        // Write exit code to /tekton/home/.exit-code so the status reporter
        // can report the correct status even when onError: continue is set.
        script: `#!/bin/sh
[ ! -d node_modules ] && npm ci
npm test; EC=$?; echo $EC > /tekton/home/.exit-code; exit $EC`,
        onError: 'continue',
    }],
});

const npmBuild = new Task({
    name: 'build-npm',
    needs: [npmTest],  // runs after test
    statusReporter,
    caches: [{
        name: 'npm',
        key: ['package-lock.json'],
        paths: ['node_modules'],
        backend: { type: 'gcs', bucket: gcsBucket, prefix: 'npm/' },
        compress: true,
        workingDir: '$(workspaces.workspace.path)',
    }],
    steps: [{
        name: 'build',
        image: nodeImage,
        workingDir: '$(workspaces.workspace.path)',
        script: `#!/bin/sh
[ ! -d node_modules ] && npm ci
npm run build; EC=$?; echo $EC > /tekton/home/.exit-code; exit $EC`,
        onError: 'continue',
    }],
});

const anchoreScann = new Task({
    name: 'anchore-scan',
    params: [refParam],
    statusReporter,
    caches: [{
        name: 'grype-db',
        key: [],           // empty key = fixed hash = always hits after first run
        paths: ['grype-db'],
        backend: { type: 'gcs', bucket: gcsBucket, prefix: 'grype/' },
        compress: true,
        forceSave: true,   // grype updates the DB in-place; always save
        maxEntries: 1,
        workingDir: '$(workspaces.workspace.path)',
    }],
    steps: [
        {
            name: 'generate-sbom',
            image: syftImage,
            script: `#!/usr/bin/env nu
^syft file:package-lock.json -o cyclonedx-json=sbom.cyclonedx.json -o syft-table`,
        },
        {
            name: 'scan',
            image: grypeImage,
            env: [{ name: 'GRYPE_DB_CACHE_DIR', value: '$(workspaces.workspace.path)/grype-db' }],
            script: `#!/usr/bin/env nu
^grype -v sbom:./sbom.cyclonedx.json -o sarif=./scan.sarif`,
            onError: 'continue',
        },
        {
            name: 'upload-sarif',
            image: DEFAULT_BASE_IMAGE,
            env: [{ name: 'GITHUB_TOKEN', valueFrom: { secretKeyRef: { name: 'github-token', key: 'token' } } }],
            script: `#!/usr/bin/env nu
let grype_ec = (try { open --raw /tekton/steps/step-scan/exitCode | str trim | into int } catch { 0 })
$grype_ec | into string | save -f /tekton/home/.exit-code
# ... upload scan.sarif to GitHub Advanced Security API`,
            onError: 'continue',
        },
    ],
});

// Push pipeline: test + scan
const pushPipeline = new GitPipeline({
    name: 'npm-push',
    triggers: [TRIGGER_EVENTS.PUSH],
    tasks: [npmTest, anchoreScann],
});

// PR pipeline: test + build + scan (build only runs on PRs)
const prPipeline = new GitPipeline({
    name: 'npm-pull-request',
    triggers: [TRIGGER_EVENTS.PULL_REQUEST],
    tasks: [npmTest, npmBuild, anchoreScann],
});

new TektonProject({
    name: 'my-app',
    namespace: 'tekton-ci',
    pipelines: [pushPipeline, prPipeline],
    outdir: '.tekton',
    workspaceStorageSize: '3Gi',
    webhookSecretRef: { secretName: 'github-webhook-secret', secretKey: 'secret' },
    gitRefParam: 'ref',
    serviceAccountAnnotations: {
        'iam.gke.io/gcp-service-account': 'tekton-ci@my-project.iam.gserviceaccount.com',
    },
});
```

## Status Reporter Exit Code Convention

The reporter reads `/tekton/home/.exit-code` (exported as `EXIT_CODE_PATH`) to determine
success/failure, since reporting tasks run their work steps with `onError: 'continue'` so the
reporting step always runs.

**With the script API this is fully automatic.** When a task has a `statusReporter` and a
`statusContext`, the framework sets `onError: 'continue'` and wraps each tagged/`scriptFromFile`/
object script so it captures the worst exit code to `EXIT_CODE_PATH` and re-exits. Write the body
as if it runs normally — no manual plumbing:

```typescript
script: sh`npm ci && npm test`   // exit-code capture injected at synth time
```

**Legacy raw-shebang strings are passed through unchanged**, so they bypass the automatic
capture. If you still author steps as raw `#!/bin/sh` strings with a status reporter, keep the
manual convention:

```sh
my-command; EC=$?; echo $EC > /tekton/home/.exit-code; exit $EC
```

Prefer the script API (see [scripting.md](scripting.md)) to avoid this entirely.
