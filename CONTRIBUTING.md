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
npm run synth         # synthesize this repo's own CI → .tekton/
npm run check         # fail if the committed .tekton/ output is stale
npm run graph         # print the self-CI task DAG (FORMAT=mermaid for a flowchart)
npm run lint:scripts  # lint extracted .sh/.bash/.nu/.py files
```

## Project structure

See [docs/architecture.md](docs/architecture.md) for how these pieces fit together and the
extension points.

The repository is an npm workspace of three packages:

```
packages/
├── tektonic/                     # @tektonic-ci/core — the core library
├── tektonic-cache-gcs/           # @tektonic-ci/cache-gcs — GcsBackend
└── tektonic-reporter-github/     # @tektonic-ci/reporter-github — GitHubStatusReporter
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
and `.tekton/` is synthesized from it, so the tags in the committed manifests are output.

Renovate only ever saw that output. Its Ansible manager matches any `tasks/*.yaml`, so
`.tekton/tasks/*.k8s.yaml` was rewritten by accident of the path while the TypeScript that
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

Three packages are published to npmjs — `@tektonic-ci/core`,
`@tektonic-ci/cache-gcs` and `@tektonic-ci/reporter-github` — by the `publish`
GitHub Actions workflow (`.github/workflows/publish.yml`), triggered by a `vX.Y.Z` tag.

**They version together.** One tag governs all three, the workflow refuses to publish unless
every `packages/*/package.json` carries that version, and core publishes first so the peer
range the providers declare is satisfiable as soon as they go live. That keeps the peer range trivial while
the seams are new; revisit independent versioning once they have held for a release or two.

Publishing uses npm **trusted publishing** (OIDC) with **staged publishing**: the workflow
mints a short-lived credential from its `id-token: write` permission, so no npm token exists
anywhere — not in the repo, not in the cluster — and uses it to *stage* each package with a
provenance attestation. A staged version is not installable until a maintainer approves it
with 2FA. The trusted publishers are deliberately left without npm's "publish directly"
option, so push access to the repo is not enough to release; the approval is the gate.

It lives in Actions rather than in Tektonic's own Tekton pipeline because npm only accepts
GitHub Actions, GitLab CI/CD and CircleCI as OIDC issuers; a self-hosted cluster cannot be a
trusted publisher (npm lists self-hosted runner support as planned). Everything else — test,
build, SBOM and vulnerability scan — still runs in Tekton on push and pull request.

### The git ref is not an install channel

`npm install github:pfenerty/tektonic` worked before the workspace split and **must not be
suggested as a fallback.** It does not fail — which is the
problem:

```
npm install github:pfenerty/tektonic
# -> added 1 package: node_modules/tektonic-workspace
# -> no dist/, no bin, require.resolve('@tektonic-ci/core') throws
```

The ref resolves to the repository root, which is now the private `tektonic-workspace` package:
no `main`, no `exports`, no `bin`, and none of the `prepare: npm run build` that made the git
ref work when the root *was* `@tektonic-ci/core`. npm has no way to install a subdirectory of
a git dependency, so there is no ref that reaches `packages/tektonic` either. The install
reports success and leaves the consumer with nothing.

The registry is the channel; the git ref is not, and the README says so.

### Cutting a release

1. Bump `version` in **every** `packages/*/package.json` to the same value, along with the
   peer range the providers declare on core, then commit and push to `main`.
2. Tag the commit `vX.Y.Z` and push the tag. The workflow refuses to stage when the tag does
   not match every package version, re-runs `npm test` and `npm run build`, and stages every
   package not already on the registry at that version.
3. Approve the stages with your passkey (npm 12+), **core first**:

   ```bash
   npm stage list @tektonic-ci/core                  # note the stage id
   npm stage approve <stage-id> --auth-type=web
   # then the same for @tektonic-ci/cache-gcs and @tektonic-ci/reporter-github
   ```

   `npm stage download <stage-id>` fetches the tarball if you want to inspect it first, and
   `npm stage reject <stage-id>` discards one. Re-running the workflow before approving stages
   the package again — reject the duplicate.

### One-time setup

Trusted publishing is configured on a package that **already exists** — `npm trust` requires
that too — so a package's very first publish is manual, and it needs an interactive 2FA
challenge. Use web auth; it works with a passkey, which is the only 2FA method npm offers some
accounts (there is no authenticator app, so no code to pass with `--otp`):

```bash
npm login --auth-type=web
npm run build
npm publish -w @tektonic-ci/cache-gcs --access public --auth-type=web
```

The publish prints an `Authenticate your account at: https://www.npmjs.com/auth/cli/…` link;
approve it with the passkey and the CLI finishes. A brand-new package can 404 on `npm view`
for several minutes afterwards while the registry CDN catches up — that is not a failed publish.

Publish from an up-to-date checkout of `main`: the tarball is whatever is on disk. That is how
`@tektonic-ci/core@2.0.0` went wrong — it was published by hand from a stale pre-split
checkout (its `gitHead` is `4768acd`), and npm never lets a version be reused, so the first real
workspace release is 2.0.1. Check `gitHead` after any manual publish:
`npm view @tektonic-ci/core gitHead`.

Every package has had its first publish (core at 2.0.0, deprecated as stale; the providers at
2.0.1), so this step should not be needed again unless a new package joins the workspace.

Then register the GitHub Actions publisher on npmjs.com → the package → Settings → Trusted
Publisher: `pfenerty` / `tektonic` / `publish.yml`, Environment blank, and leave "can also
publish directly" **unchecked**. Use the website: `npm trust github` returned a bare
`400 Bad Request` for core. All three packages are registered this way.

> Tokens are not a fallback here. npm revoked all classic automation tokens in December 2025,
> granular tokens with write access expire within 90 days, and since July 2026 a granular token
> cannot publish at all, whatever its bypass-2FA setting. Interactive 2FA and trusted publishing
> are the two remaining paths — which is why CI uses OIDC.

## Code conventions

- TypeScript strict mode
- vitest for testing
- cdk8s patterns for Kubernetes resource generation
- TSDoc comments on all public API surface
