# ADR 0002 — npm scope and versioning under the tektonic-ci org

- **Status**: accepted
- **Issue**: tektonic-uru.1 (epic tektonic-uru)
- **Date**: 2026-09-26

## Context

tektonic is moving from the single repo `pfenerty/tektonic` to the `tektonic-ci` GitHub org:
core becomes `tektonic-ci/core`, and each provider package gets a repo of its own
(`tektonic-ci/reporter-github`, `tektonic-ci/cache-gcs`). The point of the move is to make
the foundation/extension split from tektonic-k2n physical. A provider should be a package
anyone could write, built and released against the published core.

Two things have to be settled before any repo moves, because every later step writes them
into package.json, imports, peer ranges and trusted-publisher config:

1. **The npm names.** The packages are published as `@pfenerty/tektonic`,
   `@pfenerty/tektonic-cache-gcs` and `@pfenerty/tektonic-reporter-github`.
2. **The version line.** All three are lockstep at 2.0.1: core has 2.0.0 and 2.0.1, and the
   providers have only 2.0.1. The only consumers are ocidex and homelab.

## Decision

### Scope: `@tektonic-ci/*`

| Old | New | Repo |
|---|---|---|
| `@pfenerty/tektonic` | `@tektonic-ci/core` | `tektonic-ci/core` |
| `@pfenerty/tektonic-reporter-github` | `@tektonic-ci/reporter-github` | `tektonic-ci/reporter-github` |
| `@pfenerty/tektonic-cache-gcs` | `@tektonic-ci/cache-gcs` | `tektonic-ci/cache-gcs` |

- Package name = `@<org>/<repo>`, so the npm scope and the GitHub org match. A future
  provider `tektonic-ci/foo` publishes as `@tektonic-ci/foo`.
- Subpath exports keep their paths under the new name. For example, `@pfenerty/tektonic/testing`
  becomes `@tektonic-ci/core/testing`.
- The CLI binary stays `tektonic`. Only the package that provides it is renamed.
- The old packages get no further releases. Once the new names are published, each old
  package is marked with `npm deprecate` and a message naming its replacement.
- This requires creating the `tektonic-ci` npm org. Trusted publishers are then configured
  for the new package names, bound to each package's own repo (tektonic-uru.4, tektonic-uru.7).

### Rejected alternatives

- **Keep `@pfenerty/*`.** Consumers wouldn't have to rename anything, but the names would stay
  tied to a personal account. And if the move happened later anyway, users would go through a
  second rename.
- **`@tektonic/*`.** Shorter, but the scope wouldn't match the GitHub org, and it wasn't clear
  the npm org was available.

### Versioning: continue the 2.x line, and version each package independently

- **The new names carry on the 2.x API line and do not restart.** The first release under
  `@tektonic-ci/*` is simply each package's next version: core's is 2.1.0, because it adds
  `StatusReporter.pendingGroupKey()`. Restarting at 1.0.0 or 0.x would suggest a reset the
  API hasn't had. It would also put a lower version next to the deprecated 2.0.1 that people
  are migrating from.
- **After the split, packages version independently.** A provider releases only when it
  changes. Lockstep only made sense because the packages shared a repo.
- **Providers declare a peer dependency on core's major version**, `"@tektonic-ci/core": "^2"`,
  as their only dependency on core, plus a dev dependency for their own build and tests.
  Widening the peer range to a new core major is a provider release in its own right.
- **Release order for a breaking change to core:**
  1. publish a core prerelease;
  2. release the providers with widened peer ranges;
  3. release core.

  The compatibility job in tektonic-uru.9 makes the break visible at step 1 rather than
  after step 3.

## Consequences

- ocidex and homelab change package names and import paths once (tektonic-uru.10).
  `npm deprecate` points anyone else at the new names.
- Every file that names a package has to change as each repo moves:
  - package.json `name` and `peerDependencies`;
  - the docs' import examples;
  - the `check-provider-imports.mjs` core name (until that script is removed in tektonic-uru.8);
  - `examples/self-ci.ts`.
- `CHANGELOG.md` records the rename in the first `@tektonic-ci/core` release. Each provider's
  changelog continues in its own repo from 2.0.1.
