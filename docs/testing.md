# Testing your pipelines

A pipeline definition is code, so it can be unit-tested like code. `@tektonic-ci/core/testing`
synthesizes a pipeline or a task **in memory** — no files written, no cluster — and wraps the
result for the assertions tests actually make: is this task present, what gates it, what does it
run after, what params are bound.

```bash
npm install --save-dev vitest   # or your runner of choice
```

```typescript
import { describe, it, expect } from 'vitest';
import { synthPipeline } from '@tektonic-ci/core/testing';
import { prPipeline } from './pipeline';   // your own definition
```

## Asserting gating

The case worth a test: a frontend-only PR must not run the Go jobs.

```typescript
it('gates the Go tasks on Go changes', () => {
  const pr = synthPipeline(prPipeline);

  expect(pr.has('go-test')).toBe(true);
  expect(pr.isGated('go-test')).toBe(true);
  expect(pr.when('go-test')).toEqual([
    { input: '$(tasks.detect-go-changes.results.changed)', operator: 'in', values: ['true'] },
  ]);
  // The detection task is wired in as an ordering edge, not just referenced.
  expect(pr.runAfter('go-test')).toContain('detect-go-changes');

  // …and the frontend task runs unconditionally.
  expect(pr.isGated('frontend-test')).toBe(false);
});
```

`synthPipeline` runs the same code path `TektonicProject` uses to inline the spec into a PAC
PipelineRun — validation, topological sort, `runAfter` wiring, `gated()` overrides — so the test
sees exactly what would be emitted.

## `PipelineView`

| Member | Returns |
|--------|---------|
| `spec` | the raw built spec (`params`, `workspaces`, `tasks`, `finally`) |
| `taskNames` / `finallyNames` | emitted task names, in topological order |
| `paramNames` / `workspaceNames` | pipeline-level params and workspaces |
| `has(name)` | whether the pipeline emits that task |
| `task(name)` | the entry: `runAfter`, `when`, `params`, `workspaces`, `retries`, `timeout`, `matrix`, `raw` |
| `runAfter(name)` / `when(name)` / `isGated(name)` / `params(name)` | shorthands for the above |

`task()` throws and lists every emitted name when the task is absent — a missing task is usually
the point of the test.

## `TaskView`

`synthTask(task)` returns the Task manifest that would be written to `<outdir>/tasks/`, and
`synthTasks(pipeline)` does it for every task a pipeline emits, keyed by name.

```typescript
const view = synthTask(buildTask, { namespace: 'ci' });

// Framework-injected steps are present, in position.
expect(view.stepNames).toEqual(['restore-npm-cache', 'build', 'save-npm-cache', 'report-status']);
// The exit-code contract is applied to the user body, not hand-written by the author.
expect(view.script('build')).toContain('/tekton/home/.exit-code');
```

| Member | Returns |
|--------|---------|
| `manifest` | the full Task manifest |
| `name` | emitted resource name, including any project prefix |
| `stepNames` | step names in order, framework-injected steps included |
| `paramNames` | declared params, including any a status reporter merged in |
| `step(name)` / `script(name)` | one step, or its rendered script |

## Project-level output

These helpers stop at the pipeline and task level. To check that the **committed** `.tekton/`
output matches the definition — including PAC annotations, PipelineRun bindings and files the
project no longer emits — use the CLI's drift check in CI:

```bash
tektonic check
```

See [cli.md](cli.md).

## Options

Both helpers take the project-level defaults that affect synthesis, for when a test needs to
match what `TektonicProject` would produce:

```typescript
synthPipeline(pipeline, { namePrefix: 'demo', extraParams: PAC_INJECTED_PARAMS.map(p => p.toSpec()) });
synthTask(task, { namespace: 'ci', namePrefix: 'demo', defaultLanguage: 'nushell' });
```
