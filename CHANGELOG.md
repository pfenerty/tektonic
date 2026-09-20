# Changelog

Notable changes to `@pfenerty/tektonic`. This file starts at the first change after 2.0.0;
earlier history is in the git log.

## Unreleased

### Breaking: injected-step images come from the project, not from a module constant

The steps tektonic injects — git clone, cache restore/save, status reporting, change
detection — no longer default to `ghcr.io/pfenerty/apko-cicd/base:stable` (or, for GCS
caches, `ghcr.io/pfenerty/apko-cicd/gcloud:563.0.0`). Installing the library never silently
pulls from another project's registry: in a cluster whose pull secrets do not cover it, every
injected step failed with an image-pull error naming a repository the user had never heard of.

Instead, each injected step resolves its image in one documented order — the step's own
image → the component's default → the project's new `injectedStepImage` →
`DEFAULT_INJECTED_STEP_IMAGE`, a neutral public image providing `sh` and `git` only.

Because that fallback is minimal, a feature needing more now fails **at synth time** with a
message naming the capability (`nushell`, `tar`, `zstd`, `gcloud`), rather than at pod-run
time with `command not found`. Compressed caches, GCS caches and `GitHubStatusReporter` are
the features this affects.

**Both old constants are still exported, so an existing project opts back in with one line:**

```ts
new TektonicProject({
  // …
  injectedStepImage: DEFAULT_BASE_IMAGE,                    // clone, caches, reporter
  caches: [{ /* … */ backend: gcs({ bucket, image: DEFAULT_GCS_CACHE_IMAGE }) }],
});
```

Synthesized YAML is byte-identical with those two lines in place.

An image can instead declare what it provides, and tektonic checks it:

```ts
injectedStepImage: { image: 'ghcr.io/acme/ci-base:1.4.0', provides: ['sh', 'git', 'nushell'] }
```

A bare string is taken at its word — synthesis stays offline and never probes a registry.

### Breaking: `TaskDef.synth` takes an options object

`synth(scope, namespace, namePrefix?, stepSecurityContext?, defaultLanguage?, defaultImagePullPolicy?)`
became `synth(scope, namespace, opts?: TaskSynthOptions)` with those fields named. Callers
passing only `(scope, namespace)` — and everyone going through `TektonicProject` or the
testing helpers — are unaffected.

### Added

- `injectedImageRef(...capabilities)`, `ImageCapability`, `InjectedStepImage`,
  `InjectedStepImageSpec` and `DEFAULT_INJECTED_STEP_IMAGE` are exported: a third-party cache
  backend, reporter or other injector declares what its steps need instead of hardcoding an
  image, and inherits the project's choice.
- `DEFAULT_GCS_CACHE_IMAGE` is now exported from the package root.
- `SynthOptions.injectedStepImage` in `@pfenerty/tektonic/testing`.
