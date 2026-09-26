# Building a job library on tektonic

Tektonic is a **foundation**, not a job catalogue. It gives you params, workspaces, results,
tasks, pipelines, caching, status reporting and the script contract; it deliberately ships no
"scan this image", "build with buildkit" or "publish a helm chart" task. Those belong in a
library built **on** tektonic — yours, or one shared across your projects.

This page is the contract for writing one: the supported shape, which types are stable to build
against, and the two framework behaviours a task factory has to respect.

## Two layers: jobs and actions

A library ships at one of two granularities, and picking the wrong one is the usual mistake.

| | **Job** — `Task` | **Action** — `defineAction` |
|---|---|---|
| Unit of | scheduling: one Tekton Task, one pod | reuse *inside* a pod |
| Identity | a node in the DAG, with `needs`, `when`, a status context | steps inside the composing task |
| Costs | a pod start, a workspace mount, a scheduling round | nothing — it is steps |
| Shares | nothing but workspaces and results | the task's filesystem, params and workspaces |
| Hands work on by | a `Result` or a workspace file | a typed in-pod path handle |

Reach for a job when the work needs its own status context, its own gate, its own retries or
its own node. Reach for an action for the common, cheap case: two or three steps that always
run together in one pod — build, scan, upload — where a separate pod would only buy you a
second image pull.

`HubTaskRef` is the third thing and is *job*-sized: a whole remote catalog Task, a node in the
graph like any other. An action is never a node.

## The action layer

An action is a reusable, versioned unit with **declared, typed inputs** and **typed outputs**,
rendered to steps at synth time:

```typescript
import { defineAction, sh, type ActionOutput } from '@tektonic-ci/core';

export const syft = defineAction<{ image: string }, 'sbom'>({
  name: 'syft',
  version: '1.0.0',
  image: 'ghcr.io/example/syft:1.42.3',
  outputs: { sbom: 'sbom.json' },
  steps: ({ inputs, outputs }) => [
    { name: 'sbom', script: sh`syft "${inputs.image}" -o cyclonedx-json=${outputs.sbom}` },
  ],
});

export const grype = defineAction<{ sbom: ActionOutput | string }, 'sarif'>({
  name: 'grype',
  version: '1.0.0',
  image: 'ghcr.io/example/grype:0.110.0',
  outputs: { sarif: 'scan.sarif' },
  steps: ({ inputs, outputs }) => [
    { name: 'scan', script: sh`grype sbom:${inputs.sbom} -o sarif=${outputs.sarif}` },
  ],
});
```

Composing them is an array entry — actions and hand-written steps interleave freely:

```typescript
const sbom = syft({ image: 'app:1.0' });
const scan = grype({ sbom: sbom.outputs.sbom });   // typed handle, not a path string

new Task({
  name: 'dep-scan',
  statusReporter,
  steps: [sbom, scan, { name: 'show', image: 'alpine', script: sh`cat ${scan.outputs.sarif}` }],
});
```

**Outputs are typed path handles.** `scan.outputs.sarif` stringifies to
`/tektonic/actions/grype-scan.sarif`, so a downstream step interpolates it with no naming
convention to remember and no agreement to keep in sync. Tekton steps are separate containers,
so tektonic mounts a pod-scoped `emptyDir` at `/tektonic/actions` on every step of a task that
composes an action with outputs — that is what makes the handle resolvable one step later.

**Step names are `<instance>-<step>`**, except where the step is already named after the
instance (`steps: ({ name }) => [{ name, … }]`), which keeps the common single-step action from
reading `syft-syft`. The instance name defaults to the definition's `name` and is overridable —
`syft({ image }, { name: 'base-sbom' })` — which is also how the same action composes twice into
one task. Two instances under the same name are rejected at construction.

**Contributions merge upward.** An action's `params`, `workspaces`, `caches`, `volumes` and
`results` are merged into the composing task the way a `StatusReporter`'s `requiredParams`
already are, with the task's own entries winning by name. State them directly or derive them
from the inputs:

```typescript
const upload = defineAction<{ sarif: ActionOutput | string; logs: Workspace }>({
  name: 'upload-sarif',
  image: 'ghcr.io/example/gh:2.82.1',
  params: [new Param({ name: 'repo-full-name' })],   // lands on whatever task composes it
  workspaces: inputs => [inputs.logs],               // …or derived from the inputs
  steps: ({ inputs }) => [ /* … */ ],
});
```

### Crossing the pod boundary

An output path is pod-scoped: it means nothing to the *next task*. Promotion is therefore an
explicit step, never something the framework does behind your back:

```typescript
const sarifPath = new Result({ name: 'sarif-path' });

new Task({
  name: 'dep-scan',
  steps: [
    sbom,
    scan,
    scan.outputs.sarif.toWorkspace(artifacts, 'dep-scan.sarif'),  // large: a workspace file
    scan.outputs.sarif.toResult(sarifPath),                       // small: a Tekton result
  ],
});
```

Both return an action, so they read as what they are — a copy step you chose to add. The
result and the workspace are contributed upward, so neither has to be restated on the task.
`toResult` fails the step when the file exceeds Tekton's 4KB result cap rather than letting it
be truncated; `toWorkspace` is the route for anything larger. The copy runs in the producing
action's image by default (the pod is already pulling it); pass `{ image }` to override.

There is a third promotion, `toArtifact()`, which adds the thing the other two lack: a
*declaration*. It goes in the task's `produces` rather than its `steps`, because only the task
knows which workspace the artifact should live on:

```typescript
const build = new Task({
  name: 'build',
  workspaces: [workspace],
  steps: [compile],
  produces: {
    dist: compile.outputs.bundle.toArtifact(),  // an action output, promoted
    report: 'target/report.xml',                // or a path a hand-written step wrote
  },
});

const test = new Task({
  name: 'test',
  needs: [build],                          // the edge is yours to declare
  consumes: [build.artifacts.dist],        // …and this is checked against it
  steps: [{ name: 'run', image, script: sh`tar xf ${build.artifacts.dist}` }],
});
```

`build.artifacts.dist` is a `TaskArtifact`: it stringifies to the path the *consumer* reads, so
no step body hardcodes the layout. Tektonic injects a publish step at the end of the producer
and a fetch step at the start of the consumer, and then checks, at synth time:

- a consumer may only name an artifact some task in the same pipeline produces;
- the producing task must be a transitive `needs` of the consumer. Consuming does not create
  the edge — this is the check that catches "declared, but not ordered", which is a runtime
  file-not-found without it;
- an artifact declared and never consumed is a warning, not an error. Publishing something for
  a human to collect is legitimate.

Unlike a cache save, a failed publish or fetch fails the task: a cache is an optimisation, an
artifact is a handoff a downstream task is counting on.

#### Which one to reach for

| | carries | lifetime | declared? |
|---|---|---|---|
| `toResult(r)` | ≤4KB of text — a SHA, a tag, a boolean | the run | yes, as a Tekton result |
| `toArtifact()` | a file or directory of any size | the run | **yes** — producer and consumers are named and checked |
| `toWorkspace(ws)` | a file of any size | the run | no |

Take `toResult` when the value is small and you want it in `when` clauses, `fanOut` or another
task's params. Take `toArtifact` whenever another task in the pipeline reads the file — that is
the common case, and the declaration is what buys you a synth-time error instead of a runtime
one. `toWorkspace` remains the undeclared escape hatch for a file nobody in this pipeline
consumes: something a human downloads, or a tree an out-of-band process picks up.

Where the bytes actually go is a separate concern, behind `ArtifactStore`. The default
`WorkspaceArtifactStore` keeps them in a per-producer subtree of the workspace the pipeline
already binds — one writer per subtree, unlike a bare agreed-upon path. Setting
`artifactStore` swaps the transport without touching the declaration, the handle types or the
checks above — `gcsArtifacts()` from `@tektonic-ci/cache-gcs` needs no workspace at all,
which is what frees a pipeline's tasks to schedule across nodes. Tektonic can also record what
each task read and wrote as TEP-0147 provenance for Tekton Chains, which is off by default.
Both are in [artifacts.md](artifacts.md); the reasoning, and the options that lost, are in
[ADR 0001](adr/0001-artifacts-and-dependencies.md).

One vocabulary rule, worth stating because the two words are easy to swap: an **output** is
always pod-internal (`ActionOutput`, an `emptyDir` shared by the steps of one task), and an
**artifact** is always cross-pod (`TaskArtifact`). `toArtifact()` is the single point where one
becomes the other.

### What an action may not do

An action's steps are ordinary steps by the time they synthesize, so they take the step
template, the project's pull policy, a `taskPreset`'s step defaults and — importantly — the
[exit-code contract](#the-exit-code-contract) exactly as hand-written steps do. An action
cannot opt out of it: `onError: 'stopAndFail'` inside an action composed into a reporting task
is rejected at construction, and a bare `#!` body is rejected at synthesis, the same rule a
hand-written step lives under.

## The shape: a task factory

A job is a function from an options object to a `Task`. Nothing more.

```typescript
import { Task, Workspace, type Action, type StatusReporter } from '@tektonic-ci/core';
import { syft, grype } from './actions';

export interface DepScanOptions {
  /** Task name — take it as an option, because two scans in one pipeline must not collide. */
  name?: string;
  /** Image to scan, e.g. a tag your build task produced. */
  image: string;
  /** Workspace the scan runs in. */
  workspace: Workspace;
  /** Status reporter, if the caller reports to GitHub. */
  statusReporter?: StatusReporter;
  /** Extra work composed after the scan, e.g. an upload — typed actions, not loose steps. */
  extraActions?: Action<string>[];
}

export function depScanTask(opts: DepScanOptions): Task {
  const sbom = syft({ image: opts.image });
  const scan = grype({ sbom: sbom.outputs.sbom });

  return new Task({
    name: opts.name ?? 'dep-scan',
    workspaces: [opts.workspace],
    statusReporter: opts.statusReporter,
    steps: [sbom, scan, ...(opts.extraActions ?? [])],
  });
}
```

Note what the action layer removed: the SARIF path is no longer a filename two steps agree on
by convention, and the extension point is `Action[]` — units with declared inputs and outputs —
rather than `TaskStepSpec[]`, which is an untyped escape hatch whatever you name it. Take
`Action[]` when the caller extends a job; take `TaskStepSpec[]` only when you genuinely mean
"arbitrary steps I will not reason about".

Consumers then call `depScanTask({ image, workspace, statusReporter })` and put the result in a
pipeline like any other task. Because it returns a plain `Task`, everything else keeps
working: `needs`, `when`, `gated()`, `serial()`, caching, `synthTask` in tests.

**Name it, don't hard-code it.** Take `name` as an option and default it. A library task used
twice in one pipeline collides otherwise, and `TektonicProject` will reject two same-named tasks
that declare different things ([agent-guide](agent-guide.md#task-names-are-project-wide)).

## Applying project conventions with a preset

A project's tasks usually agree on more than they differ — the same reporter, resources, base
env, workspace. `taskPreset` states those once, so neither your own tasks nor a library's
wrapper has to restate them:

```typescript
import { taskPreset } from '@tektonic-ci/core';

const ciTask = taskPreset({
  statusReporter,
  workspaces: [workspace],
  stepTemplate: { workingDir: workspace.path },
  step: {
    computeResources: { requests: { cpu: '250m', memory: '512Mi' } },
    env: [{ name: 'CI', value: 'true' }],
  },
});

const test = ciTask({ name: 'test', steps: [{ name: 'test', image: goImage, script: sh`go test ./...` }] });
```

A preset reaches a composed action's steps too: the `step` defaults are merged into them the
way they are into hand-written ones (the action's own values winning per field), so a library
action picks up the project's resources, base env and security context without knowing about
them. The action instance itself is copied, not mutated, so the same one composes elsewhere
unchanged.

The call always wins: `name` and `steps` come from it, named collections (`params`,
`workspaces`, `caches`, `sidecars`, `volumes`) dedupe by name with the preset's first,
`stepTemplate` and `annotations` merge per key, and `step` defaults merge into each step with
the step winning per field (`env` by name, `volumeMounts` concatenated).

## The stable surface

These are the types a job library builds against. They are public API and change only with a
major version:

| Type | Role |
|------|------|
| `Task` / `TaskOptions` | the thing a factory returns |
| `TaskStepSpec` | a step, including `script`, `env`, `computeResources`, `volumeMounts` |
| `defineAction`, `Action`, `ActionDefinition`, `ActionCtx` | the action layer: a reusable unit of work inside a pod |
| `ActionOutput`, `ActionOutputs` | typed in-pod path handles, and their promotion to a result or workspace file |
| `TaskCacheSpec` | a cache declaration; restore/save steps are injected around your steps |
| `TaskSidecarSpec` | a sidecar, with `script`, `volumeMounts`, `readinessProbe` |
| `TaskVolumeSpec` | a Kubernetes volume on the task |
| `Param`, `Workspace`, `Result` | typed handles; `toString()` renders the Tekton expression |
| `ScriptInput`, `Script`, `sh`/`bash`/`nu`/`py`, `fragment`, `scriptFromFile` | script authoring |
| `Condition`, `equals`/`isIn`/`onBranch`/`onChanges`/`and`/`or`/`not` | gating |
| `StatusReporter`, `CacheBackend`, `ScriptLanguage`, `SynthTarget` | strategy interfaces to implement |
| `registerLanguage(lang, { extensions })` | register a `ScriptLanguage` and get its tagged-template helper |
| `PAC_PARAMS`, `PAC_EVENT_ENV` | the PAC-supplied params and event context |
| `@tektonic-ci/core/testing` | `synthPipeline` / `synthTask` for the library's own tests |

Anything prefixed `_` (`_buildSpec`, `_toPipelineTaskSpec`, `_overrides`) is internal
plumbing: it is exported for the library's own use across modules, not for yours.

## Two behaviours a factory must respect

### The exit-code contract

When the caller passes a `statusReporter`, tektonic appends a reporting step, sets
`onError: 'continue'` on your steps, and wraps each script so it records its exit code. Your
factory does **not** hand-write `echo $? > /tekton/home/.exit-code`, and must not pass step
bodies as raw `#!` strings — those are emitted verbatim, which silently opts out of the
contract and is rejected in a reporting task. Author bodies with a language tag, or state the
opt-out with `rawScript()`. See [scripting.md](scripting.md#the-exit-code-contract-handled-for-you).

### Status contexts and reporting

Take `statusReporter` as an option and pass it through; never construct one inside a job.
The reporter decides how the whole project reports, its `requiredParams` are merged into the
task automatically, and each distinct reporter instance gets its own pending and reconciler
tasks. A library that instantiates its own would report through a different pipeline than the
project's.

## Testing a job library

Job factories are ordinary functions returning ordinary objects, so test them with the same
in-memory helpers ([testing.md](testing.md)):

```typescript
import { synthTask } from '@tektonic-ci/core/testing';

it('hands the SBOM to the scanner', () => {
  const view = synthTask(depScanTask({ image: 'app:1.0', workspace }));
  expect(view.stepNames).toEqual(['syft-sbom', 'grype-scan']);
  expect(view.script('grype-scan')).toContain('grype sbom:/tektonic/actions/syft-sbom.json');
});
```

An action needs no special harness either: an instance exposes `steps`, `outputs`, `params` and
the rest before any task composes it, so a unit test asserts on those directly and an
integration test composes it into a `Task` and calls `synthTask`.

## Packaging

A job library is a normal npm package that takes `@tektonic-ci/core` as a **peer** dependency,
so the consumer's copy of the library is the one in use — task identity is object identity, and
two copies of tektonic mean two incompatible `Task` classes.

```json
{
  "peerDependencies": { "@tektonic-ci/core": "^2.0.0" },
  "devDependencies": { "@tektonic-ci/core": "^2.0.0" }
}
```
