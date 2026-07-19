# Getting started

This guide walks through building a complete Tekton CI pipeline using `@pfenerty/tektonic`. By the end you'll have tasks, a pipeline, GitHub webhook triggers, and synthesized YAML ready to apply to your cluster.

## Prerequisites

- Node.js >= 18
- A Kubernetes cluster with [Tekton Pipelines](https://tekton.dev/docs/installation/pipelines/) >= v0.59 and [Tekton Triggers](https://tekton.dev/docs/installation/triggers/) >= v0.26 installed

## 1. Install dependencies

```bash
npm install @pfenerty/tektonic cdk8s constructs
npm install -D typescript ts-node @types/node
```

## 2. Define params and workspaces

Params and workspaces are the data-passing primitives in Tekton. Create them as plain objects — they interpolate directly into step scripts via JavaScript template literals.

```typescript
import {
  Param, Workspace, Task, GitPipeline, TektonicProject, TRIGGER_EVENTS,
} from '@pfenerty/tektonic';

const workspace = new Workspace({ name: 'workspace' });
```

When used in template literals:
- `${workspace.path}` produces `$(workspaces.workspace.path)`

`url` and `revision` params are created and managed automatically by `GitPipeline` — you don't need to declare them.

## 3. Create tasks

Each `Task` declares its steps and any direct dependencies (`needs`). When using `GitPipeline`, you don't need to declare the shared workspace, set `workingDir`, or add the `git-clone` dependency — all are injected automatically.

```typescript
const npmTest = new Task({
  name: 'test-npm',
  steps: [{
    name: 'test',
    image: 'node:22-alpine',
    command: ['sh', '-c', 'npm ci && npm test'],
  }],
});

const npmBuild = new Task({
  name: 'build-npm',
  needs: [npmTest],   // ← inter-task dependency; git-clone is handled by GitPipeline
  steps: [{
    name: 'build',
    image: 'node:22-alpine',
    command: ['sh', '-c', 'npm ci && npm run build'],
  }],
});
```

The `needs` array forms a dependency graph between your tasks. Pipelines automatically discover all transitive dependencies and set `runAfter` ordering — you only need to specify direct dependencies between your own tasks.

Steps run in the workspace root (`$(workspaces.workspace.path)`) by default. Override `workingDir` on individual steps when you need a subdirectory (e.g. `workingDir: \`${workspace.path}/packages/app\``).

## 4. Compose pipelines

Use `GitPipeline` instead of `Pipeline`. It automatically creates a `git-clone` task, injects the shared workspace and default `workingDir` into every task, and wires `git-clone` as a dependency for tasks with no other explicit dependencies.

Pass `workspace` explicitly so your task steps can reference `workspace.path` when a custom `workingDir` is needed.

```typescript
const pushPipeline = new GitPipeline({
  name: 'npm-push',
  workspace,
  trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
  tasks: [npmTest],
  // Execution order: git-clone → test-npm
});

const prPipeline = new GitPipeline({
  name: 'npm-pull-request',
  workspace,
  trigger: { rules: [{ on: TRIGGER_EVENTS.PULL_REQUEST }] },
  tasks: [npmTest, npmBuild],
  // Execution order: git-clone → test-npm → build-npm
});
```

`GitPipeline` also exposes `pipeline.workspace` and `pipeline.cloneTask` if you need to reference them.

## 5. Synthesize with TektonicProject

```typescript
new TektonicProject({
  name: 'tekton-pipelines',
  namespace: 'tekton-builds',
  pipelines: [pushPipeline, prPipeline],
  outdir: '.tekton',
  repository: { url: 'https://github.com/my-org/my-app' },
});
```

This writes [Pipelines as Code](https://pipelinesascode.tekton.dev/) artifacts into `.tekton/`:
- A `Task` YAML file per unique task under `.tekton/tasks/` (git-clone, test-npm, build-npm)
- A PAC-annotated `PipelineRun` template per triggered pipeline (the pipeline spec is inlined)
- A `Repository` custom resource (when `repository` is set) linking the repo to the namespace

## 6. Commit and let PAC run it

PAC reads these files from the pushed commit — there's nothing to `kubectl apply` per run.
Commit `.tekton/` to your repository:

```bash
npx ts-node pipeline.ts   # regenerate .tekton/
git add .tekton && git commit -m "ci: update pipelines" && git push
```

Apply the generated `Repository` CR once (or manage it via GitOps):

```bash
kubectl apply -f .tekton/*-repository.k8s.yaml
```

## 7. (Optional) Add GitHub status reporting

Report commit statuses back to GitHub so pull requests show CI results inline. Create a `GitHubStatusReporter` and attach it to any task that should report:

```typescript
import { GitHubStatusReporter } from '@pfenerty/tektonic';

const statusReporter = new GitHubStatusReporter();
// Requires a 'github-token' Secret in the namespace with key 'token'

const npmTest = new Task({
  name: 'test-npm',
  statusContext: 'ci/test',   // ← label shown in the GitHub Checks UI
  statusReporter,             // ← auto-appends a status-reporting step
  steps: [{
    name: 'test',
    image: 'node:22-alpine',
    command: ['sh', '-c'],
    // capture exit code so the reporter can read it
    args: ['npm ci && npm test; EC=$?; echo $EC > /tekton/home/.exit-code; exit $EC'],
    onError: 'continue',      // ← let the reporter step run even on failure
  }],
});
```

Key points:
- `statusContext` defaults to the task `name` if omitted
- The reporter's required params (`revision`, `repo-full-name`) are **auto-injected** into the task — no need to add them to `params`
- Steps that report status must write their exit code to `/tekton/home/.exit-code` and use `onError: 'continue'` so the reporting step always runs
- Create the token secret before running pipelines:
  ```bash
  kubectl create secret generic github-token \
    --namespace=tekton-builds \
    --from-literal=token=YOUR_GITHUB_TOKEN
  ```

## 8. Connect the repository to PAC

PAC handles webhook delivery and event matching for you — there's no EventListener to expose.
Point the `repository` option at your repo and set up the PAC install once:

1. **Install PAC** in the cluster (once): see the
   [PAC installation guide](https://pipelinesascode.tekton.dev/docs/install/).
2. **Authorize PAC to your repo** — either install the PAC **GitHub App** (URL matching is
   enough; the generated `Repository` needs only `spec.url`), or configure a token/webhook
   provider via `repository.gitProvider`.
3. **Apply the `Repository` CR** so PAC knows which namespace runs this repo's pipelines:
   ```bash
   kubectl apply -f .tekton/*-repository.k8s.yaml
   ```

PAC matches events using the pipeline's `trigger.rules` (compiled to `on-event`/`on-target-branch`,
or a single `on-cel-expression` for compound rules). See the
[Pipelines as Code guide](pac.md#trigger--rules) for details.

## Full example

See [`examples/self-ci.ts`](../examples/self-ci.ts) for a complete working example that this project uses for its own CI, including status reporting and security scanning.
