# Tektonic Agent Guide

A complete reference for agents creating Tekton CI/CD pipelines with this library.

## Mental Model

- **`Param` / `Workspace`** are named handles. Use them in template literals (`${param}`, `${workspace.path}`) to produce Tekton interpolation expressions (`$(params.name)`, `$(workspaces.name.path)`).
- **`Task`** maps to one Tekton Task: a list of steps, optional params/workspaces, optional caches, and an optional status reporter.
- **Step scripts** are typed: author them with the `sh`/`bash`/`nu`/`py` tagged templates or load a real file with `scriptFromFile`. The framework owns the exit-code/status plumbing. See [scripting.md](scripting.md).
- **`GitPipeline`** wires tasks together: it auto-creates a `git-clone` step, threads the shared workspace through every task, and walks the `needs` graph to set `runAfter`. `TRIGGER_EVENTS` controls which GitHub events fire it.
- **`TektonicProject`** is the synthesizer. Calling `new TektonicProject(...)` writes in-repo [Pipelines as Code](pac.md) artifacts to `outdir`: a `Task` YAML per task under `tasks/`, a PAC-annotated `PipelineRun` template per triggered pipeline (spec inlined), and an optional `Repository` custom resource. The PAC operator reads these from the pushed commit — no EventListener or RBAC to run.

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
  TektonicProject,
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
  trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
  tasks: [test],
});

// Synthesize everything to in-repo PAC YAML
new TektonicProject({
  name: 'my-app',         // prefix for all resource names
  namespace: 'tekton-ci', // Kubernetes namespace
  pipelines: [pipeline],
  outdir: '.tekton',      // output directory (commit this to your repo)
  repository: { url: 'https://github.com/my-org/my-app' }, // optional PAC Repository CR
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
- `when` gates the job with a typed rule, `fanOut` runs it once per runtime item, and `retries`/
  `timeout` tune the TaskRun — see [Rules & Conditions](#rules--conditions) and
  [Fan-Out (dynamic jobs)](#fan-out-dynamic-jobs).

## GitPipeline

```typescript
import { GitPipeline, TRIGGER_EVENTS } from '@pfenerty/tektonic';

const pipeline = new GitPipeline({
  name: 'my-pipeline',
  trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }, { on: TRIGGER_EVENTS.PULL_REQUEST }] },
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

**Firing rules (`trigger`)** — `trigger.rules` is a list of OR-ed rules; each names its event(s)
(`on`) and its branch/path filters (`branch`, `sourceBranch`, `pathsChanged`, `pathsIgnored`).
Plus `comment`, `labels`, `cancelInProgress`, and a raw `cel` escape hatch. This controls whether
the *whole pipeline* fires — distinct from the job-level `when`/`onChanges`/`fanOut` rules (which
gate individual tasks *inside* a run). See [Trigger & rules in the PAC guide](pac.md#trigger--rules).

## TektonicProject

The synthesizer. It emits in-repo [Pipelines as Code](https://pipelinesascode.tekton.dev/)
artifacts read by the PAC operator from the pushed commit.

```typescript
new TektonicProject({
  name: 'my-app',           // Resource name prefix
  namespace: 'tekton-ci',   // Kubernetes namespace
  pipelines: [pipeline],
  outdir: '.tekton',        // commit this directory to your repo

  // Optional PAC Repository CR (repo ↔ namespace, + provider auth)
  repository: {
    url: 'https://github.com/my-org/my-app',
    // gitProvider omitted → PAC GitHub App (URL matching). For token/webhook installs:
    // gitProvider: { type: 'github', secretName: 'gh-token', webhookSecretName: 'gh-webhook' },
  },

  // Ephemeral workspace PVC (created fresh each PipelineRun)
  workspaceStorageSize: '3Gi',         // default: '1Gi'
  workspaceStorageClass: 'standard',   // omit to use cluster default
  workspaceAccessModes: ['ReadWriteOnce'], // default

  // Persistent cache PVCs (PVC backend only — not needed for GCS)
  caches: [
    { workspace: cacheWorkspace, storageSize: '5Gi', storageClassName: 'standard' },
  ],

  // PAC retains this many completed runs per repo (default 5)
  maxKeepRuns: 5,

  // Inject env into every TaskRun pod — e.g. the PAC git-auth token
  podTemplateEnv: [{
    name: 'GITHUB_TOKEN',
    valueFrom: { secretKeyRef: { name: '{{ git_auth_secret }}', key: 'git-provider-token' } },
  }],

  // Security context overrides
  defaultPodSecurityContext: { fsGroup: 1000 },
  defaultStepSecurityContext: { runAsUser: 1000 },
});
```

**What gets generated** in `outdir`:
- A `Task` YAML file per unique task under `tasks/`
- A PAC-annotated `PipelineRun` template per triggered pipeline (the pipeline spec is inlined; the
  `trigger` rules → `on-event`/`on-target-branch` or a single `on-cel-expression`)
- A `Repository` custom resource when `repository` is set
- A `PersistentVolumeClaim` is *not* generated — bind cache PVCs via the `caches` option; PAC
  binds them into each PipelineRun

Well-known params are bound to PAC variables automatically: `url` → `{{ repo_url }}`, `revision`
→ `{{ revision }}`, `repo-full-name` → `{{ repo_owner }}/{{ repo_name }}`, `source-branch` →
`{{ source_branch }}`. See [pac.md](pac.md) for the full model. Status reporting is available
two ways: PAC reports the PipelineRun outcome to the provider natively, and `GitHubStatusReporter`
(below) adds per-context commit statuses — use `skipTokenInjection: true` under PAC so it reuses
the git-auth token from `podTemplateEnv`.

## Caching

Caches inject a restore step before your steps and a save step after. Hit/miss is hash-based (SHA256 of the key files), matching GitLab CI's `cache:` keyword behavior.

### GCS backend (GKE + Workload Identity)

No PVC needed. Archives stored in a GCS bucket. Requires Workload Identity on GKE.

```typescript
caches: [{
  name: 'npm',                          // used in step names: restore-npm-cache / save-npm-cache
  key: ['package-lock.json'],           // files whose content determines the cache key
  paths: ['node_modules'],              // directories to restore/save
  backend: gcs({ bucket: 'my-ci-cache', prefix: 'npm/' }),
  compress: true,                       // zstd compression (recommended for GCS)
  workingDir: '$(workspaces.workspace.path)',
}]
// No CacheSpec entry needed in TektonicProject for GCS.
// Workload Identity: annotate the PipelineRun ServiceAccount out of band (PAC does not create it).
```

### PVC backend (homelab / NFS)

Archives stored on a PersistentVolumeClaim. Declare the workspace and register it in `TektonicProject.caches`.

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

// In TektonicProject:
caches: [{ workspace: npmCache, storageSize: '5Gi' }]
```

### Cache options

| Field | Default | Description |
|-------|---------|-------------|
| `name` | required | Step name prefix (`restore-{name}-cache`) |
| `key` | required | Key files; `[]` = fixed hash (always hits after first run) |
| `paths` | required | Paths to cache relative to `workingDir` |
| `backend` | PVC | `gcs({ bucket, prefix? })` for GCS |
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

## Rules & Conditions

Gate a job with a typed, composable rule via the `when` **task attribute**. Rules are plain
values — name them, reuse them across tasks, and unit-test them. They compile to Tekton `when`
guards.

```typescript
import { Task, onBranch, onBranchMatching, equals, and, not } from '@pfenerty/tektonic';

const test = new Task({
  name: 'test',
  when: onBranchMatching('^(main|release/.*)$'), // only on main or release/* branches
  steps: [/* ... */],
});

const deploy = new Task({
  name: 'deploy',
  when: onBranch('main').and(equals(approval, 'yes')), // AND-composed
  steps: [/* ... */],
});
```

**Constructors** (all take typed handles — `Param`, `Result`, or a string — never a hand-written
`$(...)`):

| Constructor | Meaning | Compiles to |
|-------------|---------|-------------|
| `equals(h, v)` / `notEquals(h, v)` | exact (in)equality | classic `in` / `notin` |
| `isIn(h, vs)` / `notIn(h, vs)` | set membership | classic `in` / `notin` |
| `matches(h, re)` | RE2 regex match | CEL guard |
| `onBranch(name)` / `onBranches(names)` | on the given branch(es) | classic `in` |
| `onBranchMatching(pattern)` | branch matches an RE2 pattern | CEL guard |
| `a.and(b)` / `and(...)` | logical AND | concatenated `when` clauses |
| `or(...)` | logical OR | single CEL guard |
| `not(c)` | negation | flips `in`↔`notin`, else CEL |

`onBranch*` reference the normalized `source-branch` pipeline param (e.g. `main`), which
`TektonicProject` binds to PAC's `{{ source_branch }}` variable. For a plain `Pipeline` with no
triggers, supply a `source-branch` param yourself, or pass your own `Result` to `equals`/`matches`.

### File-change rules (`onChanges`)

Gate a job on **whether files changed at runtime** (GitLab `rules:changes`). `onChanges(paths)`
creates a detection task that diffs the checked-out commit against a **trunk branch** and writes a
boolean result, then returns a `Condition` gating on it. The detection task is **auto-wired** into
the graph — no manual `needs`.

```typescript
import { Task, onBranch, onChanges, or } from '@pfenerty/tektonic';

const integration = new Task({
  name: 'integration',
  // always on main / merges to main; on feature branches only when these paths changed
  when: or(onBranch('main'), onChanges(['src/**', 'package.json'])),
  steps: [/* ... */],
});
```

`onChanges` accepts an array of git glob pathspecs, or an options object
(`{ paths, name?, base?, image?, workspace? }`). The detection task fetches the **trunk branch**
(`base`, default `'main'`) and diffs `base...HEAD` (three-dot merge-base) — i.e. the paths this
branch changed relative to trunk. This works uniformly on push and pull_request without any
trigger plumbing.

**Notes & limits:**
- Detection uses `git diff` in-repo (no token, portable). It is **accurate with**
  `GitPipeline({ cloneDepth: 'full' })`; on the default shallow clone the merge-base is
  unreachable and detection **fails open** (the gated job runs). It also fails open when the trunk
  can't be fetched (e.g. a brand-new repo).
- `onChanges` creates one detection task named `detect-changes` by default — reuse the returned
  `Condition`, or pass `name` for multiple independent change checks (duplicate task names are
  rejected by pipeline validation). Override the trunk with `base` (e.g. `{ paths, base: 'develop' }`).
- For a plain `Pipeline` (no `GitPipeline`), pass `workspace` so the detection task has the repo.

> **Classic vs. CEL.** Exact-match rules (`equals`, `isIn`, `onBranch`, …) use Tekton's classic
> `in`/`notin` guards and need **no** cluster configuration. Pattern/OR rules (`matches`,
> `onBranchMatching`, `or`, and negation of compound conditions) compile to **CEL** guards, which
> require the cluster's `enable-cel-in-whenexpression` feature flag. The DSL keeps this boundary
> visible so you know which rules carry a runtime requirement.

`when` also accepts raw `WhenClause[]` for full control.

## Fan-Out (dynamic jobs)

Run one job per item discovered **at runtime** via the `fanOut` task attribute. A parse task emits
an array `Result`; a downstream task fans out over it into one TaskRun per element, using a Tekton
`matrix`. The number of jobs is unknown until the parse task runs.

```typescript
import { Task, Param, Result, fanOut } from '@pfenerty/tektonic'; // fanOut only needed for the helper form

// 1. Parse task emits a runtime array (e.g. writes ["api","web"] to the result path).
const changed = new Result({ name: 'changed-services', type: 'array' });
const detect = new Task({
  name: 'detect-changes',
  results: [changed],
  steps: [{ name: 'detect', image, script: sh`node scripts/changed-services.mjs > ${changed.path}` }],
});

// 2. Per-item task declares a string Param; each element fills it.
const service = new Param({ name: 'service' });
const deploy = new Task({
  name: 'deploy',
  params: [service],                       // must declare the `as` Param
  when: onBranch('main'),                  // rules and fan-out combine
  fanOut: { over: changed, as: service },  // `as` is the typed Param handle, not a string
  steps: [{ name: 'deploy', image, script: sh`./deploy.sh ${service}` }],
});

new GitPipeline({ trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] }, tasks: [detect, deploy] });
```

This emits `matrix: { params: [{ name: service, value: $(tasks.detect-changes.results.changed-services[*]) }] }`
on `deploy`, with `runAfter: [detect-changes]`.

**`fanOut` options:**

| Field | Type | Description |
|-------|------|-------------|
| `over` | `Result` | Array-typed result driving the fan-out (`type: 'array'`) |
| `as` | `Param` | The string Param (declared in the task's `params`) each element fills |
| `from?` | `TaskLike` | Producing task for the ordering edge; defaults to `over.owner` |

**Notes:** the producing task is auto-added to `needs`, so ordering, auto-discovery, and cycle
checks work without extra wiring. The matrixed param is supplied per-element by the matrix, so it
is **not** surfaced as a pipeline-level param (but it is still declared on the produced Task
manifest). Tekton array results are JSON — the parse task writes e.g. `["api","web"]`.

## Conditional Tasks (gated)

For most cases use the `when`/`fanOut` **task attributes** above. `gated()` remains as the
per-pipeline-edge escape hatch: it wraps a task with overrides — `when` (a `Condition` or raw
clauses), `retries`, `timeout`, `matrix` — applied only for that one pipeline appearance, so the
**same task instance** can be conditional in one pipeline and unconditional in another.

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

## Multi-provider

Because output is Pipelines as Code, provider support (GitHub, GitLab, Bitbucket, Gitea, …) is
handled by the PAC operator, not by Tektonic — there is no per-provider trigger code to write.
Select the provider, if needed, via `repository.gitProvider.type`; the pipeline/task model is
identical across providers.

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
    TektonicProject,
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
        backend: gcs({ bucket: gcsBucket, prefix: 'npm/' }),
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
        backend: gcs({ bucket: gcsBucket, prefix: 'npm/' }),
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
        backend: gcs({ bucket: gcsBucket, prefix: 'grype/' }),
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
    trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
    tasks: [npmTest, anchoreScann],
});

// PR pipeline: test + build + scan (build only runs on PRs)
const prPipeline = new GitPipeline({
    name: 'npm-pull-request',
    trigger: { rules: [{ on: TRIGGER_EVENTS.PULL_REQUEST }] },
    tasks: [npmTest, npmBuild, anchoreScann],
});

new TektonicProject({
    name: 'my-app',
    namespace: 'tekton-ci',
    pipelines: [pushPipeline, prPipeline],
    outdir: '.tekton',
    workspaceStorageSize: '3Gi',
    repository: { url: 'https://github.com/my-org/my-app' },
    // Provide the GitHub token (status reporting, SARIF upload) via PAC's git-auth secret.
    podTemplateEnv: [{
        name: 'GITHUB_TOKEN',
        valueFrom: { secretKeyRef: { name: '{{ git_auth_secret }}', key: 'git-provider-token' } },
    }],
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
