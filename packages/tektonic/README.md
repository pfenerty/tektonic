# @pfenerty/tektonic

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://github.com/pfenerty/tektonic/blob/main/LICENSE)

**Define Tekton CI/CD pipelines as strongly-typed TypeScript — declarative in spirit, without
the pain of YAML.** Tektonic is a [cdk8s](https://cdk8s.io/)-based library for composing params,
workspaces, tasks, and pipelines as real code, then synthesizing in-repo
[Pipelines as Code](https://pipelinesascode.tekton.dev/) (PAC) artifacts that the PAC operator
runs directly from your repository.

Full documentation lives in the repository:
**[github.com/pfenerty/tektonic](https://github.com/pfenerty/tektonic)**.

## Install

```bash
npm install @pfenerty/tektonic cdk8s constructs
```

Optional provider packages, each taking this one as a peer dependency:

| Package | What it adds |
|---|---|
| [`@pfenerty/tektonic-cache-gcs`](https://www.npmjs.com/package/@pfenerty/tektonic-cache-gcs) | `gcs({ bucket })` — cache archives in a Google Cloud Storage bucket |
| [`@pfenerty/tektonic-reporter-github`](https://www.npmjs.com/package/@pfenerty/tektonic-reporter-github) | `GitHubStatusReporter` — per-task GitHub commit statuses |

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

## CLI

Installing the package also provides a `tektonic` binary that drives your project definition:

```bash
npx tektonic synth     # write the manifests
npx tektonic check     # fail if the committed output is stale, missing or orphaned
npx tektonic graph     # print the task DAG (--format mermaid for a flowchart)
npx tektonic lint      # shellcheck / nu-check / py_compile over your script files
```

## Documentation

- [Getting started](https://github.com/pfenerty/tektonic/blob/main/docs/getting-started.md)
- [Agent guide](https://github.com/pfenerty/tektonic/blob/main/docs/agent-guide.md) — full API reference
- [Caching](https://github.com/pfenerty/tektonic/blob/main/docs/caching.md) · [Custom cache backends](https://github.com/pfenerty/tektonic/blob/main/docs/cache-backends.md)
- [Status reporters](https://github.com/pfenerty/tektonic/blob/main/docs/status-reporters.md)
- [Scripting](https://github.com/pfenerty/tektonic/blob/main/docs/scripting.md) · [Testing pipelines](https://github.com/pfenerty/tektonic/blob/main/docs/testing.md)
- [Architecture & internals](https://github.com/pfenerty/tektonic/blob/main/docs/architecture.md)
- [Changelog](https://github.com/pfenerty/tektonic/blob/main/CHANGELOG.md)

## Requirements

| Dependency | Version |
|-----------|---------|
| Node.js | >= 18, or >= 22.18 to run a TypeScript entrypoint |
| cdk8s | >= 2.0 |
| constructs | >= 10.0 |
| Tekton Pipelines | >= v0.59 |
| Pipelines as Code (PAC) | installed in-cluster |

## License

[Apache-2.0](https://github.com/pfenerty/tektonic/blob/main/LICENSE)
