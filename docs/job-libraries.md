# Building a job library on tektonic

Tektonic is a **foundation**, not a job catalogue. It gives you params, workspaces, results,
tasks, pipelines, caching, status reporting and the script contract; it deliberately ships no
"scan this image", "build with buildkit" or "publish a helm chart" task. Those belong in a
library built **on** tektonic — yours, or one shared across your projects.

This page is the contract for writing one: the supported shape, which types are stable to build
against, and the two framework behaviours a task factory has to respect.

## The shape: a task factory

A job is a function from an options object to a `Task`. Nothing more.

```typescript
import { Task, Workspace, Result, sh, type TaskStepSpec, type StatusReporter } from '@pfenerty/tektonic';

export interface DepScanOptions {
  /** Task name — required, because two scans in one pipeline must not collide. */
  name?: string;
  /** Image to scan, e.g. a tag your build task produced. */
  image: string;
  /** Workspace the scan runs in. */
  workspace: Workspace;
  /** Status reporter, if the caller reports to GitHub. */
  statusReporter?: StatusReporter;
  /** Extra steps appended after the scan, e.g. an upload. */
  extraSteps?: TaskStepSpec[];
}

export function depScanTask(opts: DepScanOptions): Task {
  const sarif = new Result({ name: 'sarif-path', description: 'Path of the emitted SARIF report' });

  return new Task({
    name: opts.name ?? 'dep-scan',
    workspaces: [opts.workspace],
    results: [sarif],
    statusReporter: opts.statusReporter,
    steps: [
      {
        name: 'sbom',
        image: 'ghcr.io/example/syft:1.42.3',
        script: sh`syft "${opts.image}" -o cyclonedx-json=sbom.json`,
      },
      {
        name: 'scan',
        image: 'ghcr.io/example/grype:0.110.0',
        script: sh`
          grype sbom:./sbom.json -o sarif=./scan.sarif
          printf './scan.sarif' > ${sarif.path}
        `,
      },
      ...(opts.extraSteps ?? []),
    ],
  });
}
```

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
import { taskPreset } from '@pfenerty/tektonic';

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
| `TaskCacheSpec` | a cache declaration; restore/save steps are injected around your steps |
| `TaskSidecarSpec` | a sidecar, with `script`, `volumeMounts`, `readinessProbe` |
| `TaskVolumeSpec` | a Kubernetes volume on the task |
| `Param`, `Workspace`, `Result` | typed handles; `toString()` renders the Tekton expression |
| `ScriptInput`, `Script`, `sh`/`bash`/`nu`/`py`, `fragment`, `scriptFromFile` | script authoring |
| `Condition`, `equals`/`isIn`/`onBranch`/`onChanges`/`and`/`or`/`not` | gating |
| `StatusReporter`, `CacheBackend`, `ScriptLanguage`, `SynthTarget` | strategy interfaces to implement |
| `PAC_PARAMS`, `PAC_EVENT_ENV` | the PAC-supplied params and event context |
| `@pfenerty/tektonic/testing` | `synthPipeline` / `synthTask` for the library's own tests |

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
import { synthTask } from '@pfenerty/tektonic/testing';

it('emits the SARIF path result', () => {
  const view = synthTask(depScanTask({ image: 'app:1.0', workspace }));
  expect(view.stepNames).toEqual(['sbom', 'scan']);
  expect(view.script('scan')).toContain('grype sbom:./sbom.json');
});
```

## Packaging

A job library is a normal npm package that takes `@pfenerty/tektonic` as a **peer** dependency,
so the consumer's copy of the library is the one in use — task identity is object identity, and
two copies of tektonic mean two incompatible `Task` classes.

```json
{
  "peerDependencies": { "@pfenerty/tektonic": "^2.0.0" },
  "devDependencies": { "@pfenerty/tektonic": "^2.0.0" }
}
```
