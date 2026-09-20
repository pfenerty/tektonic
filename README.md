# @pfenerty/tektonic

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**Define Tekton CI/CD pipelines as strongly-typed TypeScript — declarative in spirit, without
the pain of YAML.** Tektonic is a [cdk8s](https://cdk8s.io/)-based library for composing params,
workspaces, tasks, and pipelines as real code, then synthesizing in-repo
[Pipelines as Code](https://pipelinesascode.tekton.dev/) (PAC) artifacts that the PAC operator
runs directly from your repository.

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
- **Jobs *and* actions** — a `Task` is a job (one pod, one node in the graph); an `Action` is
  reusable, versioned work *inside* one, with typed inputs and typed output path handles instead
  of steps that agree on a filename by convention. See
  [docs/job-libraries.md](docs/job-libraries.md#the-action-layer).
- **Scripts as first-class, testable files** — write step bodies in real `.sh`/`.bash`/`.nu`/
  `.py` files with IDE highlighting and linting, and unit-test them by running the real
  interpreter. See [docs/scripting.md](docs/scripting.md).
- **Pluggable strategies, proven** — caching, status reporting, script languages and synthesis
  itself are strategy interfaces. The GCS backend and the GitHub reporter ship as *separate
  packages* that consume only tektonic's published surface, so "you can implement your own"
  is something CI checks rather than something the README claims.
- **GitOps-native via PAC** — output is in-repo `.tekton/` PipelineRun templates read from the
  pushed commit, so the pipeline that runs is always exactly what was committed. Multi-provider
  (GitHub, GitLab, Bitbucket, Gitea) is handled by the PAC operator — no per-provider trigger
  wiring to maintain.
- **A base, not a straitjacket** — Tektonic provides primitives and opt-in helpers
  (`GitPipeline`, caching). It never dictates how *you* build your app.
- **Portable output** — it emits plain Tekton + PAC resources. No runtime dependency on Tektonic
  in your cluster.

## Packages

| Package | What it is |
|---|---|
| [`@pfenerty/tektonic`](packages/tektonic) | The library: primitives, pipelines, PAC/Tekton synthesis, the `tektonic` CLI, and the PVC cache backend |
| [`@pfenerty/tektonic-cache-gcs`](packages/tektonic-cache-gcs) | `gcs({ bucket })` — cache archives in a Google Cloud Storage bucket |
| [`@pfenerty/tektonic-reporter-github`](packages/tektonic-reporter-github) | `GitHubStatusReporter` — per-task GitHub commit statuses |

The provider packages take `@pfenerty/tektonic` as a peer dependency and version together with
it. Install only what you use.

## Install

```bash
npm install @pfenerty/tektonic cdk8s constructs
# optional, as needed:
npm install @pfenerty/tektonic-cache-gcs @pfenerty/tektonic-reporter-github
```

Published to npmjs as public packages — no registry configuration or auth needed. Releases are
cut by tagging `vX.Y.Z`, published through npm trusted publishing (OIDC, with a provenance
attestation and no stored token); see [CONTRIBUTING.md](CONTRIBUTING.md#releasing).

## Quick example

```typescript
import {
  Workspace, Task, GitPipeline, TektonicProject, TRIGGER_EVENTS, nu,
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
  trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
  workspace,
  tasks: [test],
  // git-clone is auto-created; test runs after it automatically
});

new TektonicProject({
  name: 'my-app',
  namespace: 'tekton-builds',
  pipelines: [pushPipeline],
  outdir: '.tekton',
  repository: { url: 'https://github.com/my-org/my-app' },
});
// → writes in-repo PAC PipelineRun templates + Task files (+ a Repository CR) under .tekton/
```

Prefer to keep larger scripts in their own files? Load them with `scriptFromFile` — the language
is inferred from the extension and the body is testable on its own:

```typescript
import * as path from 'path';
import { scriptFromFile } from '@pfenerty/tektonic';

steps: [{ name: 'fmt', image: goImage, script: scriptFromFile(path.join(__dirname, 'fmt.nu')) }]
```

## CLI

Installing the package also provides a `tektonic` binary that drives your project definition:

```bash
npx tektonic synth     # write the manifests
npx tektonic check     # fail if the committed output is stale, missing or orphaned
npx tektonic graph     # print the task DAG (--format mermaid for a flowchart)
npx tektonic lint      # shellcheck / nu-check / py_compile over your script files
```

See [docs/cli.md](docs/cli.md).

## Documentation

- [Getting started](docs/getting-started.md) — build a complete pipeline end to end
- [Agent guide](docs/agent-guide.md) — full API reference with examples
- [CLI](docs/cli.md) — `tektonic synth`, `check`, `graph`, `lint`
- [Building a job library](docs/job-libraries.md) — jobs and actions, task factories, presets, and the stable surface to build on
- [Testing pipelines](docs/testing.md) — assert graph shape and gating in memory, no cluster
- [Scripting](docs/scripting.md) — language tags, `scriptFromFile`, the exit-code contract, testing
- [Caching](docs/caching.md) — PVC & GCS caches, compression, save strategies
- [Secrets & security](docs/secrets.md) — env/file secret injection and security defaults
- [Tekton Chains](docs/chains.md) — automatic SLSA provenance: git source, image subjects, signing annotations
- [Pipelines as Code](docs/pac.md) — `TektonicProject` and in-repo `.tekton/` pipelines
- [Custom cache backends](docs/cache-backends.md) — implement the `CacheBackend` interface
- [Status reporters](docs/status-reporters.md) — implement the `StatusReporter` interface
- [Architecture & internals](docs/architecture.md) — how Tektonic is built (for contributors)

## Requirements

| Dependency | Version |
|-----------|---------|
| Node.js | >= 18, or >= 22.18 to run a TypeScript entrypoint (`node` strips the types; no loader needed) |
| cdk8s | >= 2.0 |
| constructs | >= 10.0 |
| Tekton Pipelines | >= v0.59 |
| Pipelines as Code (PAC) | installed in-cluster |

## Development

Every command runs from the repository root, across all three workspace packages.

```bash
flox activate -- npm install       # install dependencies
flox activate -- npm run build     # tsc -b → packages/*/dist/
flox activate -- npm test          # provider-import check, build, then tests
flox activate -- npm run lint:scripts  # lint extracted .sh/.bash/.nu/.py files
flox activate -- npm run synth     # synthesize this repo's own CI into .tektonic/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture.md](docs/architecture.md) to work
on Tektonic itself.

## License

[Apache-2.0](LICENSE)
