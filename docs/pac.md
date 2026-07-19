# Pipelines as Code (PAC)

[`TektonicProject`](agent-guide.md#tektonicproject) is Tektonic's synthesizer. It generates
[Pipelines as Code](https://pipelinesascode.tekton.dev/) artifacts that live in your repo and
are read directly from the pushed commit at runtime — no EventListener, no RBAC, no Flux sync
race, and the pipeline that runs is always exactly what was committed. PAC also handles webhook
delivery, event matching, status reporting, and multi-provider support (GitHub, GitLab,
Bitbucket, Gitea) for you.

**Requires** the PAC operator installed in the cluster.

## What it generates

```typescript
import { GitPipeline, TektonicProject, TRIGGER_EVENTS } from '@pfenerty/tektonic';

new TektonicProject({
  name: 'ocidex',
  namespace: 'ocidex-ci',
  pipelines: [pushPipeline, prPipeline, tagPipeline],
  outdir: '../.tekton',
  repoRelativePath: '.tekton',
});
```

This writes:

- `<outdir>/tasks/<task>.k8s.yaml` — one `Task` file per unique task across all pipelines
  (including `finally` tasks).
- `<outdir>/<pipeline>.k8s.yaml` — one PAC-annotated `PipelineRun` template per pipeline that
  has a `trigger`. The pipeline spec is **inlined** into the PipelineRun (`pipelineSpec`), and the
  task files are referenced via the `pipelinesascode.tekton.dev/task` annotation.

Only pipelines with a `trigger` are emitted.

## Trigger & rules

A pipeline's `trigger` decides **whether the whole PipelineRun fires** for an event. It's a list
of **rules** (OR-ed together); each rule names its own event(s) and branch/path filters (which AND
together). This is *pipeline-level* — distinct from the job-level `when`/`onChanges`/`fanOut` rules
that gate individual tasks *inside* a run (see the [agent guide](agent-guide.md#rules--conditions)).

```typescript
// simplest — every push:
const push = new GitPipeline({ name: 'push', trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] }, tasks });

// PRs merging into main, only when src changed:
const ci = new GitPipeline({
  name: 'ci',
  trigger: { rules: [{ on: TRIGGER_EVENTS.PULL_REQUEST, branch: 'main', pathsChanged: ['src/**'] }] },
  tasks,
});

// compound — always on main, feature branches only when src/deps changed:
const monorepo = new GitPipeline({
  name: 'monorepo',
  trigger: {
    rules: [
      { on: [TRIGGER_EVENTS.PUSH, TRIGGER_EVENTS.PULL_REQUEST], branch: 'main' },
      { on: TRIGGER_EVENTS.PUSH,         branch: 'feature/*',       pathsChanged: ['src/**'] },
      { on: TRIGGER_EVENTS.PULL_REQUEST, sourceBranch: 'feature/*', pathsChanged: ['src/**'] },
    ],
    comment: '^/ci',           // also start on a `/ci` PR comment
    cancelInProgress: true,    // supersede older runs of this PR
  },
  tasks,
});
```

**Rule fields** (`TriggerRule`):

| Field | Meaning | Maps to |
|-------|---------|---------|
| `on` | event(s) this rule matches (required) | PAC `event` / `on-event` |
| `branch` | the branch the event concerns — **pushed** branch (push) or **target/into** branch (PR). Glob(s) | `on-target-branch` / `target_branch` |
| `sourceBranch` | PR **head/from** branch. Glob(s) | `source_branch` (CEL only) |
| `pathsChanged` | run only if changed files match these globs | `on-path-changed` / `files.all` |
| `pathsIgnored` | skip when only these changed | `on-path-change-ignore` |
| `cel` | raw PAC CEL fragment, AND-ed into the rule | — |

**Trigger fields** (`PipelineTrigger`): `rules` (required), `comment` (`on-comment` regex),
`labels` (`on-label`), `cancelInProgress` (`cancel-in-progress`), and `cel` (raw whole-expression
`on-cel-expression`, used instead of `rules`).

**Branch semantics.** `branch` is unambiguous because each rule names its event: for `push` it's the
pushed branch; for `pull_request` it's the **target** (merge-into) branch. Use `sourceBranch` for the
PR **head** (merge-from). A `TAG` rule always targets `refs/tags/*`.

**How it compiles.** A single rule with only `on`/`branch`/`pathsChanged` emits discrete
`on-event`/`on-target-branch`/`on-path-changed` annotations (no CEL). Anything compound — multiple
rules, any `sourceBranch`, or `cel` — compiles to a single `on-cel-expression` (evaluated by the PAC
operator; no Tekton feature flag). `comment`/`labels`/`cancelInProgress` always emit as their own
annotations. TAG rules always target `refs/tags/*`.

## Param bindings

PAC injects template variables at trigger time. `TektonicProject` binds well-known pipeline params to
those variables automatically, so a task that declares e.g. a `url` param receives the repo URL
with no extra wiring:

| Param | PAC template variable |
|-------|-----------------------|
| `url` | `{{ repo_url }}` |
| `revision` | `{{ revision }}` |
| `project-name` | `{{ repo_name }}` |
| `repo-full-name` | `{{ repo_owner }}/{{ repo_name }}` |
| `source-branch` | `{{ source_branch }}` |

`project-name`, `repo-full-name`, and `source-branch` are added as pipeline params
automatically. `url` and `revision` are the params `GitPipeline` already creates for its
git-clone task — so a `GitPipeline` + `TektonicProject` combination is wired end-to-end with no
manual params. Any param without a known binding is emitted with an empty value for you to fill
in.

## Workspaces and caches

Each `PipelineRun` gets workspace bindings derived from the inlined spec:

- Cache workspaces (those listed in `caches`) bind to a persistent PVC by `claimName`
  (`<name>-<workspace>` when a project `name` prefix is set, else the workspace name).
- Every other workspace binds to an ephemeral `volumeClaimTemplate`, sized by
  `workspaceStorageSize` (default `1Gi`) with optional `workspaceStorageClass`.

GCS-backed caches need no PVC and are filtered out of the workspace bindings.

```typescript
new TektonicProject({
  name: 'ocidex',
  namespace: 'ocidex-ci',
  pipelines: [pushPipeline, prPipeline, tagPipeline],
  outdir: '../.tekton',
  repoRelativePath: '.tekton',
  serviceAccountName: 'default',
  workspaceStorageSize: '5Gi',
  workspaceStorageClass: 'local-path',
  defaultPodSecurityContext: { runAsUser: 1024, runAsGroup: 1024, fsGroup: 1024 },
  caches: [
    { workspace: goCacheWs, storageSize: '5Gi', storageClassName: 'local-path' },
    { workspace: nodeCacheWs, storageSize: '2Gi', storageClassName: 'local-path' },
  ],
});
```

## `outdir` vs `repoRelativePath`

`outdir` is where files are written on disk; `repoRelativePath` is the path baked into the PAC
task annotation. They differ when you synthesize from a subdirectory:

```typescript
outdir: '../.tekton',        // write up one level from the synth script
repoRelativePath: '.tekton', // but reference tasks as `.tekton/tasks/...` from the repo root
```

When `repoRelativePath` is omitted it defaults to `outdir`.

## Options reference

| Option | Default | Description |
|--------|---------|-------------|
| `namespace` | required | Namespace for Task and PipelineRun resources |
| `pipelines` | required | Pipelines to synthesize (only triggered ones are emitted) |
| `name` | — | Prefix applied to all generated resource names |
| `outdir` | `.tekton` | Output directory; tasks go to `<outdir>/tasks/` |
| `repoRelativePath` | `outdir` | Repo-relative path used in task annotations |
| `caches` | — | Persistent cache volumes bound in every PipelineRun |
| `workspaceStorageSize` | `1Gi` | Ephemeral workspace PVC size |
| `workspaceStorageClass` | — | StorageClass for the ephemeral workspace |
| `workspaceAccessModes` | `['ReadWriteOnce']` | Access modes for the ephemeral workspace |
| `serviceAccountName` | `tekton-triggers` | ServiceAccount for PipelineRun pods |
| `maxKeepRuns` | `5` | Completed runs PAC retains per repo |
| `defaultPodSecurityContext` | — | Merged over `DEFAULT_POD_SECURITY_CONTEXT` |
| `defaultStepSecurityContext` | — | Merged over `DEFAULT_STEP_SECURITY_CONTEXT` |
| `defaultLanguage` | — | Default script language for bare-body steps |
| `podTemplateEnv` | — | Env injected into every step of every task (see below) |

### `podTemplateEnv`

Inject env into every TaskRun pod — useful for the PAC git auth token, whose secret name is
itself a PAC template variable resolved before the run reaches Kubernetes:

```typescript
podTemplateEnv: [{
  name: 'GITHUB_TOKEN',
  valueFrom: { secretKeyRef: { name: '{{ git_auth_secret }}', key: 'git-provider-token' } },
}]
```

See [secrets.md](secrets.md) for secret-injection patterns and [caching.md](caching.md) for
cache configuration.
