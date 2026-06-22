# @pfenerty/tektonic

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**Define Tekton CI/CD pipelines as strongly-typed TypeScript — declarative in spirit, without
the pain of YAML.** Tektonic is a [cdk8s](https://cdk8s.io/)-based library for composing params,
workspaces, tasks, and pipelines as real code, then synthesizing standard Tekton YAML.

YAML-based CI/CD is fine until you need anything dynamic: a matrix, a shared task across
pipelines, a conditional stage, a script longer than a few lines. Then it turns into copy-paste,
anchors, and untestable inline shell. Tektonic keeps the declarative *feel* — you describe tasks
and how they depend on each other — but gives you a real type system, real functions, and real
files underneath.

## Why tektonic

- **Type-safe by construction** — params, workspaces, results, and step specs are typed; a
  mistake is a compile error, not a failed PipelineRun.
- **Declarative dependency graph** — declare `task.needs`; the library discovers transitive
  dependencies, validates the graph, rejects cycles, and topologically orders execution.
- **Scripts as first-class, testable files** — write step bodies in real `.sh`/`.bash`/`.nu`/
  `.py` files with IDE highlighting and linting, and unit-test them by running the real
  interpreter. See [docs/scripting.md](docs/scripting.md).
- **No vendor lock-in** — caching, VCS triggers, status reporting, and script languages are
  pluggable strategy interfaces. Built-ins for PVC/GCS caching and GitHub ship in the box; swap
  in your own without forking.
- **A base, not a straitjacket** — Tektonic provides primitives and opt-in helpers
  (`GitPipeline`, caching, Pipelines-as-Code). It never dictates how *you* build your app.
- **Portable output** — it emits plain Tekton resources. No runtime dependency on Tektonic in
  your cluster.

## Install

```bash
npm install @pfenerty/tektonic cdk8s constructs
```

## Quick example

```typescript
import {
  Workspace, Task, GitPipeline, TektonProject, TRIGGER_EVENTS, nu,
} from '@pfenerty/tektonic';

const workspace = new Workspace({ name: 'workspace' });

const test = new Task({
  name: 'test',
  steps: [{
    name: 'test',
    image: 'node:22-alpine',
    script: nu`npm ci; npm test`,   // typed, dedented, language-aware
  }],
});

const pushPipeline = new GitPipeline({
  triggers: [TRIGGER_EVENTS.PUSH],
  workspace,
  tasks: [test],
  // git-clone is auto-created; test runs after it automatically
});

new TektonProject({
  name: 'my-app',
  namespace: 'tekton-builds',
  pipelines: [pushPipeline],
  webhookSecretRef: { secretName: 'github-webhook-secret', secretKey: 'secret' },
});
// → writes YAML for Tasks, Pipeline, RBAC, EventListener, TriggerBindings/Templates
```

Prefer to keep larger scripts in their own files? Load them with `scriptFromFile` — the language
is inferred from the extension and the body is testable on its own:

```typescript
import * as path from 'path';
import { scriptFromFile } from '@pfenerty/tektonic';

steps: [{ name: 'fmt', image: goImage, script: scriptFromFile(path.join(__dirname, 'fmt.nu')) }]
```

## Documentation

- [Getting started](docs/getting-started.md) — build a complete pipeline end to end
- [Agent guide](docs/agent-guide.md) — full API reference with examples
- [Scripting](docs/scripting.md) — language tags, `scriptFromFile`, the exit-code contract, testing
- [Caching](docs/caching.md) — PVC & GCS caches, compression, save strategies
- [Secrets & security](docs/secrets.md) — env/file secret injection and security defaults
- [Tekton Chains](docs/chains.md) — automatic SLSA provenance: git source, image subjects, signing annotations
- [Pipelines as Code](docs/pac.md) — `PACProject` and in-repo `.tekton/` pipelines
- [Triggers](docs/triggers.md) — GitHub webhook trigger infrastructure
- [Custom cache backends](docs/cache-backends.md) — implement the `CacheBackend` interface
- [Architecture & internals](docs/architecture.md) — how Tektonic is built (for contributors)

## Requirements

| Dependency | Version |
|-----------|---------|
| Node.js | >= 18 |
| cdk8s | >= 2.0 |
| constructs | >= 10.0 |
| Tekton Pipelines | >= v0.59 |
| Tekton Triggers | >= v0.26 |

## Development

```bash
flox activate -- npm install       # install dependencies
flox activate -- npm run build     # compile TypeScript → dist/
flox activate -- npm test          # run tests
flox activate -- npm run lint:scripts  # lint extracted .sh/.bash/.nu/.py files
flox activate -- npm run docs:api  # generate API docs with TypeDoc
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture.md](docs/architecture.md) to work
on Tektonic itself.

## License

[Apache-2.0](LICENSE)
