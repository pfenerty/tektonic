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

### Script languages are an open registry

`ScriptLanguage` was documented as an extension point but was only half open: a third party
could construct `new Script(myLanguage, body)` and nothing else. The name union and the
extension map at `src/lib/script/` were both closed, so a registered language could not reach
`scriptFromFile`, the `{ language, body }` object form, task or project `defaultLanguage`, or
`tektonic lint`'s file discovery.

`registerLanguage(lang, { extensions })` opens it, and returns the language's tagged-template
helper so registration and use are one step:

```ts
export const rb = registerLanguage(new Ruby(), { extensions: ['.rb'] });
// then: script: rb`puts "hi"`
```

The four built-ins register through the same function at import time — there is no privileged
path into the registry. A name may be registered once (a second registration throws rather
than overriding at a distance); a conflicting extension warns and the last one wins.

`LanguageName` is now `KnownLanguageName | (string & {})`: any registered name type-checks
where a built-in does, and `'nushell'` still autocompletes. The only source-compatible break
is a `@ts-expect-error` on a call like `languageFor('ruby')` — that is a runtime error now,
not a type error.

`@pfenerty/tektonic/testing` gained `assertExitCodeContract(language, opts)` and
`interpreterAvailable(bin)`. The exit-code contract is the one thing a language may not
choose: a `wrap` that ignores `ctx.captureExitCode` reports a failed step as green. The
helper renders a body, runs it with the real interpreter, and asserts both the process exit
code and the contract file.

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
- `registerLanguage`, `unregisterLanguage`, `registeredLanguageNames`,
  `registeredExtensions`, `languageNameForExtension`, and the `KnownLanguageName`,
  `ScriptTag` and `RegisterLanguageOptions` types.
- `assertExitCodeContract` and `interpreterAvailable` in `@pfenerty/tektonic/testing`.
- `tektonic lint` discovers files from the language registry: `lintableExtensions()` replaces
  the `LINTABLE_EXTENSIONS` constant in `src/cli/lint.ts`.

### Changed

- `DEFAULT_GCS_CACHE_IMAGE` now pins `ghcr.io/pfenerty/apko-cicd/gcloud:581.0.0` (was
  `563.0.0`). The tag had been bumped in this repo's synthesized manifests but not in the
  constant that generates them; Renovate now updates the constant itself, so the two cannot
  diverge again. See [CONTRIBUTING](CONTRIBUTING.md#dependency-updates).
