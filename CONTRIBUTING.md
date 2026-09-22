# Contributing

## Development setup

This project uses [Flox](https://flox.dev/) for environment management. All commands should be run inside `flox activate`.

```bash
flox activate
npm install
```

## Commands

All of these run from the repository root, across every workspace package.

```bash
npm run build         # tsc -b across the workspace → packages/*/dist/
npm test              # provider-import check, build, then the test suite (vitest)
npm run lint:imports  # fail if a provider package reaches into core's internals
npm run synth         # synthesize this repo's own CI → .tektonic/
npm run check         # fail if the committed .tektonic/ output is stale
npm run graph         # print the self-CI task DAG (FORMAT=mermaid for a flowchart)
npm run lint:scripts  # lint extracted .sh/.bash/.nu/.py files
```

## Project structure

See [docs/architecture.md](docs/architecture.md) for how these pieces fit together and the
extension points.

The repository is an npm workspace of three packages:

```
packages/
├── tektonic/                     # @pfenerty/tektonic — the core library
├── tektonic-cache-gcs/           # @pfenerty/tektonic-cache-gcs — GcsBackend
└── tektonic-reporter-github/     # @pfenerty/tektonic-reporter-github — GitHubStatusReporter
```

The two provider packages take core as a **peer** dependency and may import it only through
its published surface — no deep imports, no relative paths into core. That restriction is the
point of the split, so it is enforced: `scripts/check-provider-imports.mjs` fails the build
on a violation, and `npm test` runs it first. When a provider genuinely needs something core
keeps internal, export it from `packages/tektonic/src/index.ts` and document it as supported
API — that decision is what this check forces into the open.

At a glance, inside `packages/tektonic` — every bare `src/…` path below is relative to it:

```
src/
├── index.ts                      # public API re-exports (the entire public surface)
├── constants.ts                  # API versions, defaults, security contexts, images
├── cli/                          # the `tektonic` CLI (synth, check, graph, lint)
└── lib/
    ├── core/                     # primitives, orchestrators, extension interfaces
    │   ├── param.ts  workspace.ts  result.ts
    │   ├── task.ts               # TaskDef (aka Task)
    │   ├── pipeline.ts  git-pipeline.ts  pipeline-task.ts
    │   ├── tektonic-project.ts   # builds the SynthModel, runs the targets
    │   ├── hub-task-ref.ts  trigger.ts  trigger-events.ts
    │   └── cache-backend.ts  status-reporter.ts  synth-target.ts   # extension interfaces
    ├── script/                   # ScriptLanguage plugins (sh/bash/nushell/python) + from-file
    ├── cache/                    # PvcBackend + shared helpers published for backend authors
    └── targets/                  # SynthTarget implementations (pac/, tekton/)
examples/
├── main.ts                       # Go pipeline example
└── self-ci.ts                    # this project's own CI pipeline
docs/                             # see README.md for the full doc index
```

## Testing

Tests use [vitest](https://vitest.dev/) and live alongside source files as `*.test.ts`.

```bash
npm test              # single run
npm run test:watch    # watch mode
```

Two patterns dominate (both detailed in [docs/architecture.md](docs/architecture.md#testing)):

- **Synthesis assertions** — construct primitives, build a spec, and assert the resulting object
  shape (params inferred, `runAfter` correct, cycle rejected).
- **Script runtime** — render a body through a `ScriptLanguage.wrap`, execute it with the real
  interpreter, and assert the exit code *and* the contract file. See
  `src/lib/script/runtime.test.ts`; guard each case with `it.skipIf(!has(interpreter))` so the
  suite stays hermetic.

Run `tektonic lint` (or `npm run lint:scripts`) to syntax-check any `.sh`/`.bash`/`.nu`/`.py` files under `src/`.

## Pull requests

1. Create a feature branch from `main`
2. Make your changes
3. Ensure `npm run build` and `npm test` pass
4. Open a PR against `main`

## Dependency updates

Renovate opens the dependency PRs. Image pins are the awkward case: they live in TypeScript,
and `.tektonic/` is synthesized from it, so the tags in the committed manifests are output.

Renovate only ever saw that output. Its Ansible manager matches any `tasks/*.yaml`, so
`.tektonic/tasks/*.k8s.yaml` was rewritten by accident of the path while the TypeScript that
generates it stayed behind — the bumps were real, `npm run check` was red, and the next
`npm run synth` would have reverted them.

So the pins themselves are under Renovate now, through a `customManagers` regex in
`renovate.json` covering `packages/tektonic/src/lib/constants.ts`,
`packages/tektonic-cache-gcs/src/gcs-backend.ts` and `examples/self-ci.ts`. Add a file to that list when it grows a versioned image literal; a
floating tag such as `base:stable` is skipped, since the regex requires a leading digit.
(`config:recommended` ignores `examples/` by default, which is why `ignorePaths` is spelled
out in full without it.)

Renovate groups every update of one image onto a single branch whatever manager found it, so
a bump arrives as one PR carrying the source change and the manifests that follow from it.
The `check-manifests` step in the self-CI `test-npm` task is the guard that keeps that honest:
it runs `npm run check`, which synthesizes into a temp directory and diffs against what is
committed, and its exit code is folded into the GitHub status. **If it fails, run
`npm run synth` and commit the result** — the TypeScript wins, always.

## Releasing

Three packages are published to npmjs — `@pfenerty/tektonic`,
`@pfenerty/tektonic-cache-gcs` and `@pfenerty/tektonic-reporter-github` — by the `publish`
GitHub Actions workflow (`.github/workflows/publish.yml`), triggered by a `vX.Y.Z` tag.

> **This section describes the intended release, not the committed workflow.** The workspace
> split left `publish.yml` assuming a single package at the repository root: its tag check reads
> the private root `package.json`, whose `version` is `undefined`, so **every tag fails the
> guard**, and its publish step is a bare `npm publish` that never reaches the provider
> packages. Cutting a release today fails rather than publishing something wrong. The corrected
> file is written and verified but cannot be pushed from an agent session — GitHub refuses any
> write under `.github/workflows/` without `workflow` scope — so it needs a human. The exact
> content is in tektonic-46j.11's design field; tektonic-46j.12 tracks the install story that
> depends on it.

**They version together.** One tag governs all three, the workflow refuses to publish unless
every `packages/*/package.json` carries that version, and core publishes first so the peer
range the providers declare is already satisfiable. That keeps the peer range trivial while
the seams are new; revisit independent versioning once they have held for a release or two.

Publishing uses npm **trusted publishing** (OIDC): the workflow mints a short-lived credential
from its `id-token: write` permission, so no npm token exists anywhere — not in the repo, not in
the cluster. npm also generates a provenance attestation automatically, since this is a public
package built from a public repo.

It lives in Actions rather than in Tektonic's own Tekton pipeline because npm only accepts
GitHub Actions, GitLab CI/CD and CircleCI as OIDC issuers; a self-hosted cluster cannot be a
trusted publisher (npm lists self-hosted runner support as planned). Everything else — test,
build, SBOM and vulnerability scan — still runs in Tekton on push and pull request.

### The git ref is not an install channel

`npm install github:pfenerty/tektonic` worked before the workspace split and **must not be
suggested as a fallback while the packages are unpublished.** It does not fail — which is the
problem:

```
npm install github:pfenerty/tektonic
# -> added 1 package: node_modules/tektonic-workspace
# -> no dist/, no bin, require.resolve('@pfenerty/tektonic') throws
```

The ref resolves to the repository root, which is now the private `tektonic-workspace` package:
no `main`, no `exports`, no `bin`, and none of the `prepare: npm run build` that made the git
ref work when the root *was* `@pfenerty/tektonic`. npm has no way to install a subdirectory of
a git dependency, so there is no ref that reaches `packages/tektonic` either. The install
reports success and leaves the consumer with nothing.

So until the first release is cut, the only way to consume tektonic is to build from a clone.
The registry is the channel; the git ref is not, and the README says so.

### Cutting a release

1. Bump `version` in **every** `packages/*/package.json` to the same value, along with the
   peer range the providers declare on core, then commit and push to `main`.
2. Tag the commit `vX.Y.Z` and push the tag. The workflow refuses to publish when the tag does
   not match every package version, re-runs `npm test` and `npm run build`, and skips any
   package already on the registry at that version — so re-running a release is safe.

### One-time setup

Trusted publishing is configured on a package that **already exists** — `npm trust` requires
that too — so the very first publish is manual, and it needs an interactive 2FA challenge.

**All three packages need this, not just the two new ones.** `@pfenerty/tektonic` has never
been published either: `npm view @pfenerty/tektonic` is a 404, and the newest tag in the repo is
`v1.4.0` — the v2.0.0 release commit was never tagged.

```bash
npm login                                    # a 2FA session, valid for two hours
npm publish -w @pfenerty/tektonic --access public --otp=123456                  # core first
npm publish -w @pfenerty/tektonic-cache-gcs --access public --otp=123456
npm publish -w @pfenerty/tektonic-reporter-github --access public --otp=123456
```

Core goes first so the peer range the providers declare on it is satisfiable the moment they
appear on the registry.

The `--otp` is not optional. A web-login session alone gets
`403 … Two-factor authentication or granular access token with bypass 2fa enabled is required`,
and npm does not reliably prompt for the code. If the account's only 2FA method is a passkey or
security key there is no code to pass — enroll an authenticator app under Account → Two-Factor
Authentication first.

Then register the GitHub Actions publisher, either from the CLI (npm 11.10+, also 2FA-gated):

```bash
npm trust github --repo pfenerty/tektonic --file publish.yml --allow-publish
```

or on npmjs.com → the package → Settings → Trusted Publishers. Every release after that goes
through the tag alone.

> Tokens are not a fallback here. npm revoked all classic automation tokens in December 2025,
> granular tokens with write access expire within 90 days, and since July 2026 a granular token
> cannot publish at all, whatever its bypass-2FA setting. Interactive 2FA and trusted publishing
> are the two remaining paths — which is why CI uses OIDC.

## Code conventions

- TypeScript strict mode
- vitest for testing
- cdk8s patterns for Kubernetes resource generation
- TSDoc comments on all public API surface
