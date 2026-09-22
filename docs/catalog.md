# Publishing to a Tekton catalog

Tektonic has always been able to *consume* a catalog task: `HubTaskRef` emits a `taskRef`
resolved through Tekton's `hub` resolver, and the task itself lives in someone else's
repository. `HubTarget` is the other half — it publishes a task you wrote as a catalog entry,
in the layout a catalog repository expects.

The two sides round-trip: a task this repository publishes at `0.1` is consumable from any
other tektonic project as `new HubTaskRef({ taskName, version: '0.1' })`, with the param and
workspace names matching by construction because both come from the same declaration.

## Marking a task publishable

A task becomes a catalog entry by carrying `catalog` metadata. Nothing about how it runs
changes; every other target ignores the field.

```typescript
import { Task, Param, Result } from '@pfenerty/tektonic';

const url = new Param({ name: 'url', description: 'Repository URL to clone from' });
const commit = new Result({ name: 'commit', description: 'Full commit SHA' });

const clone = new Task({
  name: 'git-clone',
  catalog: {
    version: '0.1',
    description: 'Clones a git repository onto a workspace and reports its metadata.',
    displayName: 'Git Clone',
    categories: ['Git'],
    tags: ['git', 'clone'],
    platforms: ['linux/amd64', 'linux/arm64'],
  },
  params: [url],
  results: [commit],
  workspaces: [workspace],
  steps: [/* … */],
});
```

`GitPipeline` takes the same metadata for the `git-clone` task it generates, via
`cloneCatalog`.

| Field | Required | Notes |
|-------|----------|-------|
| `version` | yes | `major.minor` or `major.minor.patch`, no leading `v`. Names the directory. |
| `description` | yes | The hub lists entries by it; also becomes `spec.description`. |
| `displayName` | no | Defaults to the task name. |
| `categories` | no | A closed union — `CATALOG_CATEGORIES` is the hub's own list. |
| `tags` | no | Free-form; the hub indexes them for search. |
| `platforms` | no | Defaults to `linux/amd64`. |
| `minPipelinesVersion` | no | Defaults to `0.44.0`, the first release serving `tekton.dev/v1` for `Task`. |

## Emitting the catalog tree

Add `HubTarget` to the project's targets. It emits **only** the tasks carrying `catalog`, so it
composes with whatever else the project publishes:

```typescript
new TektonicProject({
  namespace: 'ci',
  pipelines,
  outdir: '.tekton',
  targets: [new PacTarget({ repository: { url } }), new HubTarget()],
});
```

```
.tekton/task/git-clone/0.1/git-clone.yaml
.tekton/task/git-clone/0.1/README.md
```

Usually you want the catalog somewhere of its own, which is what `--target` is for:

```bash
tektonic synth --target hub --outdir catalog
```

`--target` narrows a synthesis to targets the project already declares — it cannot add one, and
naming a target the project does not declare fails rather than quietly emitting nothing.

### What the entry is, and is not

The manifest is the same one every other target emits, with everything local to *this*
repository taken back off it:

- **no namespace** — a catalog entry is applied wherever the consumer wants it;
- **no project name prefix** — `resourceName` scopes resources inside one namespace, and a
  catalog entry is named by the directory it lives in;
- **no PAC annotations** — those describe how *this* repository's runs are delivered.

What it gains: `spec.description`, an `app.kubernetes.io/version` label, and the
`tekton.dev/displayName`, `tekton.dev/platforms`, `tekton.dev/categories`, `tekton.dev/tags` and
`tekton.dev/pipelines.minVersion` annotations. Annotations the task set itself (Tekton Chains
controls, say) are carried through.

### The generated README

Every entry gets a `README.md` built from the manifest being published: the install snippet in
both forms, then a table each for params, results and workspaces, then platforms, categories and
tags. It is generated rather than hand-written because a catalog README is a restatement of the
task's own declarations, and a hand-written one is stale the first time a param is added. Pass
`readme: false` to skip it.

## Validation

`HubTarget` validates each entry at synth time and throws with every problem it found, rather
than one at a time. The hub's own checks run when a pull request is already open against the
catalog repository, which is a slow way to learn that a param has no description.

| Rejected | Why |
|----------|-----|
| a param or result with no description | the entry's README and the hub's UI are generated from them |
| an image from a registry a consumer cannot pull anonymously | the entry works for its author and nobody else |
| a category the hub does not know | the hub drops it silently, costing a published version |
| a version that is not `major.minor[.patch]` | the directory name *is* the version |
| an empty description | the hub lists entries by it |

The registry check uses `PUBLIC_REGISTRIES` — `docker.io`, `ghcr.io`, `quay.io`, `gcr.io`,
`registry.k8s.io`, `mcr.microsoft.com`, `public.ecr.aws`, `cgr.dev`. Pass `allowedRegistries` to
replace that list when publishing to a catalog whose consumers all share a registry. An image
that is a param reference is the *consumer's* choice and is not checked.

This is also why an injected step's image matters here: tektonic's fallback
(`DEFAULT_INJECTED_STEP_IMAGE`) is a neutral public image, so a project that publishes a task
built on injected steps passes. A project that set `injectedStepImage` to a private registry
does not, and finds out at synth time.

## Actually publishing

Tektonic writes the tree and stops. A catalog entry is landed by a pull request against the
catalog repository, so there is nothing for the tool to push — which is why the CLI reaches this
as `synth --target hub` and not a `publish` command.

Catalog versions are **immutable**. Emitting over an existing `<version>` directory is how a
published entry gets rewritten by accident: bump `version` for every change rather than
re-cutting one.

## Consuming it back

```typescript
import { HubTaskRef, Param, Workspace } from '@pfenerty/tektonic';

const clone = new HubTaskRef({
  catalog: 'tekton',
  taskName: 'git-clone',
  version: '0.1',
  params: [new Param({ name: 'url' }), new Param({ name: 'revision' })],
  workspaces: [new Workspace({ name: 'workspace' })],
});
```

`HubTaskRef` is `synthesizable: false`, so no local `Task` is emitted for it — the resolver
fetches the published one at run time. See [pac.md](pac.md) for the targets that surround it.
