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
  has triggers. The pipeline spec is **inlined** into the PipelineRun (`pipelineSpec`), and the
  task files are referenced via the `pipelinesascode.tekton.dev/task` annotation.

Only pipelines with `triggers` are emitted.

## Event and branch mapping

Pipeline `triggers` map to PAC's `on-event` annotation, and `onTargetBranch` maps to
`on-target-branch`:

| `TRIGGER_EVENTS` | PAC `on-event` |
|------------------|----------------|
| `PUSH`           | `push` |
| `PULL_REQUEST`   | `pull_request` |
| `TAG`            | `push` (with `on-target-branch: [refs/tags/*]`) |

```typescript
const pushPipeline = new GitPipeline({
  name: 'app-push',
  triggers: [TRIGGER_EVENTS.PUSH],
  onTargetBranch: 'main',   // → on-target-branch: [main]; defaults to '*'
  tasks: [test, build],
});
```

TAG pipelines always target `refs/tags/*` regardless of `onTargetBranch`.

## Matching (`match`)

For richer *pipeline-level* matching, set `match` on a pipeline. It maps to PAC's
`pipelinesascode.tekton.dev/*` annotations and decides whether the **whole PipelineRun** fires
for an event. (This is distinct from the job-level `when`/`onChanges`/`fanOut` rules that gate
individual tasks *inside* a run — see the [agent guide](agent-guide.md#rules--conditions).)

```typescript
const ci = new GitPipeline({
  name: 'ci',
  triggers: [TRIGGER_EVENTS.PULL_REQUEST],
  onTargetBranch: 'main',
  match: {
    pathsChanged: ['src/**', 'package.json'], // start only when these change
    onComment: '^/ci',                         // ...or on a `/ci` PR comment
    cancelInProgress: true,                    // supersede older runs of this PR
  },
  tasks: [test, build],
});
```

| `match` field | PAC annotation | Notes |
|---------------|----------------|-------|
| `cel` | `on-cel-expression` | Raw CEL escape hatch. **Replaces** `on-event`/`on-target-branch` — put the event/branch checks in the CEL yourself. |
| `pathsChanged` | `on-path-changed` | Glob list; PAC computes the diff. |
| `pathsIgnored` | `on-path-change-ignore` | Glob list. |
| `onComment` | `on-comment` | Regex; pair with a `pull_request` trigger. |
| `onLabel` | `on-label` | Label list; pair with a `pull_request` trigger. |
| `cancelInProgress` | `cancel-in-progress` | Cancel a running instance when a newer event arrives. |

All fields except `cel` combine with `on-event`/`on-target-branch`. PAC's CEL namespace
(`event`, `source_branch`, `target_branch`, `files.all`, …) differs from Tekton `when`-CEL, so
`cel` takes a raw PAC expression, e.g.
`event == "pull_request" && files.all.exists(f, f.matches("src/.*"))`.

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
