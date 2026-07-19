# Architecture & internals

This is the contributor's guide to how Tektonic is built — read it before changing the core or
adding an extension. For *using* the library, start with the [getting-started](getting-started.md)
and [agent guide](agent-guide.md).

## Design goals

Tektonic exists to make CI/CD pipelines **strongly typed but declarative in spirit**, without
the ceremony and stringly-typed fragility of hand-written YAML. Three principles follow:

1. **The library is a base, not a framework.** Core types (`Param`, `Workspace`, `Result`,
   `Task`, `Pipeline`) are pure orchestration primitives. Tektonic never prescribes how you
   build, test, or deploy your application — opinions like git-cloning live in opt-in subclasses
   (`GitPipeline`) and overridable constants (`DEFAULT_BASE_IMAGE`).
2. **Provider concerns are pluggable.** Caching, VCS triggers, status reporting, and scripting
   languages are all strategy interfaces with built-in implementations, so no provider is baked
   into the core.
3. **The framework owns cross-cutting plumbing.** Exit-code capture, cache restore/save steps,
   git-clone, and status reporting are generated at synth time so consumers write intent, not
   boilerplate.

## Layout

```
src/
├── index.ts                  # the entire public API surface (re-exports)
├── constants.ts              # API versions, security contexts, default images/resources
└── lib/
    ├── core/                 # primitives + orchestrators + extension interfaces
    │   ├── param.ts  workspace.ts  result.ts        # named handles, stringify to $(...) exprs
    │   ├── task.ts                                   # TaskDef: the synthesizable unit of work
    │   ├── pipeline.ts  git-pipeline.ts             # graph discovery, validation, topo-sort
    │   ├── pipeline-task.ts                          # gated() per-edge overrides (when/retry/timeout)
    │   ├── condition.ts  changes.ts                  # typed rules DSL + onChanges detection
    │   ├── tektonic-project.ts                       # the PAC synthesizer
    │   ├── hub-task-ref.ts                           # TaskLike that references an ArtifactHub task
    │   ├── cache-backend.ts  status-reporter.ts     # extension interfaces
    │   └── trigger-events.ts
    ├── script/               # ScriptLanguage plugins (sh/bash/nushell/python) + from-file
    ├── cache/                # PvcBackend, GcsBackend, shared cache helpers
    └── reporters/            # GitHubStatusReporter
```

Everything a consumer can touch is re-exported from `src/index.ts` — if it isn't there, it's
internal. Keep that file the single source of truth for the public surface.

## The synthesis flow

Nothing is emitted until a synthesizer runs. The pipeline:

1. **Construct primitives.** `Param`/`Workspace`/`Result` are inert handles; their `toString()`
   / `.path` getters produce Tekton interpolation expressions (`$(params.x)`,
   `$(workspaces.x.path)`, `$(tasks.t.results.r)`). This is why a tagged-template script can
   interpolate them directly.
2. **Construct tasks.** `TaskDef` (aliased as `Task`) stores steps, params, workspaces, caches,
   results, and an optional status reporter. The constructor does light wiring: it merges a
   reporter's `requiredParams` into the task's params, auto-registers PVC cache workspaces, and
   binds each `Result` to the task name.
3. **Construct a pipeline.** `Pipeline` walks `task.needs` transitively (`discoverAllTasks`),
   detects status-reporting tasks and prepends a generated "set pending" task, and collects
   cache `finally` tasks. `GitPipeline` additionally creates the git-clone task and threads the
   shared workspace through every task.
4. **Synthesize.** `TektonicProject`/`TektonicProject` call `pipeline._buildSpec()`, which validates the
   graph, topologically sorts it, infers the param/workspace union, and emits the spec. Each
   `TaskDef.synth()` renders its steps (including injected restore/save/reporter steps and
   script wrapping) into a cdk8s `ApiObject`. cdk8s writes the YAML.

### Dependency discovery, validation, ordering

`Pipeline` owns the graph logic in one place (`src/lib/core/pipeline.ts`):

- `discoverAllTasks` — DFS over `needs` to pull in transitive dependencies, so consumers only
  declare *direct* edges.
- `validate` — rejects duplicate task names and edges to tasks outside the pipeline.
- `topoSort` — orders tasks and throws on cycles.
- `inferParams` / `inferWorkspaces` — de-duplicated union across all tasks, so params/workspaces
  surface at the pipeline level automatically (params with a `pipelineExpression` are excluded —
  they're computed, not inputs).
- `runAfterFor` — computes each task's `runAfter`. It's `protected` and the single override point
  for subclasses.

### GitPipeline vs Pipeline

`GitPipeline` is the canonical example of an opinion layered on the base without polluting it:

- It creates a `git-clone` `TaskDef` (with `url`/`revision` params and eight git-metadata
  results) and a shared `workspace`.
- It **mutates user tasks idempotently**: adds the workspace if absent and sets a default
  `stepTemplate.workingDir` to the workspace path. Both are guarded so the same task instance can
  appear in multiple pipelines safely.
- It injects `git-clone` as a `runAfter` for root tasks by **overriding `runAfterFor`** — it
  never touches `task.needs`, preserving task reusability.

This is the pattern to follow for new opinionated pipeline types: subclass `Pipeline`, override
`runAfterFor`, mutate only idempotently.

### The synthesizer

`TektonicProject` consumes `Pipeline._buildSpec()` and emits per-pipeline PAC `PipelineRun`
templates with the spec **inlined**, one `Task` file per unique task, and an optional `Repository`
custom resource — binding well-known params to PAC `{{ }}` variables. PAC (the operator) owns
webhook delivery, event matching, status reporting, and multi-provider support, so Tektonic has no
trigger/EventListener/RBAC code of its own. See [pac.md](pac.md).

## Extension points

Tektonic has three strategy interfaces. Adding a provider means implementing one — never editing
the core. Each is exported from `index.ts`.

### `ScriptLanguage` (`src/lib/script/types.ts`)

Renders a step body: a shebang, a `wrap(body, ctx)` that adds a `log` preamble and honours the
exit-code contract (`ScriptCtx.captureExitCode` → write the worst code to `ctx.exitCodePath` and
re-exit), and a `lintCommand(file)` for the dev harness. Reuse via inheritance where possible —
`Bash` extends `Sh` and only changes the shebang. See [scripting.md](scripting.md). Test new
languages with the execute-and-assert pattern in `src/lib/script/runtime.test.ts`.

### `CacheBackend` (`src/lib/core/cache-backend.ts`)

Returns a `restoreStep` and `saveStep` for a `TaskCacheSpec`. `needsPvcWorkspace` tells
`TaskDef` whether to auto-register the cache workspace and wire finally-task workspaces. `PvcBackend`
and `GcsBackend` are the built-ins; shared key-hashing/compression helpers live in
`src/lib/cache/shared.ts`. See [cache-backends.md](cache-backends.md).

### `StatusReporter` (`src/lib/core/status-reporter.ts`)

Supplies `requiredParams`, a `createPendingTask(contexts)` (run first to mark everything pending),
and a `finalStep(context)` appended to each reporting task. The final step reads
`EXIT_CODE_PATH` — which the framework guarantees is populated because reporting tasks render
their user steps with exit-code capture and `onError: 'continue'`. `GitHubStatusReporter` is the
built-in.

## Key design decisions

- **Why cdk8s?** It gives a typed construct tree and battle-tested YAML emission, so Tektonic
  focuses on the Tekton domain model rather than on serialization.
- **Why template-literal interpolation for params/workspaces?** Tekton's `$(...)` expressions are
  just strings; making the handles `toString()` to those strings means interpolation needs no
  special API and composes naturally inside scripts.
- **Why discover dependencies transitively from `needs`?** Consumers declare intent (A needs B)
  once; the library derives the full graph and ordering. Tasks never carry pipeline-specific
  state, so a task instance is reusable across pipelines.
- **Why have the framework own the exit-code contract?** It's the kind of fiddly, copy-pasted
  plumbing that YAML CI makes ugly. Centralising it in the `ScriptLanguage` wrappers keeps
  consumer scripts clean and correct by construction. See [scripting.md](scripting.md#the-exit-code-contract-handled-for-you).

## Testing

Tests use [vitest](https://vitest.dev/) and live next to source as `*.test.ts`. Two patterns
dominate:

- **Synthesis assertions** — construct primitives, build a spec, and assert on the resulting
  object shape (params inferred, `runAfter` correct, cycle rejected).
- **Script runtime** — render a body through a `ScriptLanguage.wrap`, execute it with the real
  interpreter, and assert the process exit code *and* the contract file
  (`src/lib/script/runtime.test.ts`). Guard each case with `it.skipIf(!has(interpreter))` to keep
  the suite hermetic.

Run `npm test`, and `npm run lint:scripts` to lint any `.sh`/`.bash`/`.nu`/`.py` files under
`src/`.
