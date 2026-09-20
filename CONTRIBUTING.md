# Contributing

## Development setup

This project uses [Flox](https://flox.dev/) for environment management. All commands should be run inside `flox activate`.

```bash
flox activate
npm install
```

## Commands

```bash
npm run build         # compile TypeScript → dist/
npm test              # run test suite (vitest)
npm run synth         # synthesize this repo's own CI → .tektonic/
npm run check         # fail if the committed .tektonic/ output is stale
npm run graph         # print the self-CI task DAG (FORMAT=mermaid for a flowchart)
npm run lint:scripts  # lint extracted .sh/.bash/.nu/.py files
```

## Project structure

See [docs/architecture.md](docs/architecture.md) for how these pieces fit together and the
extension points. At a glance:

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
    ├── cache/                    # PvcBackend, GcsBackend, shared helpers
    ├── reporters/                # GitHubStatusReporter
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
`renovate.json` covering `src/lib/cache/gcs-backend.ts`, `src/lib/constants.ts` and
`examples/self-ci.ts`. Add a file to that list when it grows a versioned image literal; a
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

The package is published to **npmjs as `@pfenerty/tektonic`** by the `publish` GitHub Actions
workflow (`.github/workflows/publish.yml`), triggered by a `vX.Y.Z` tag.

Publishing uses npm **trusted publishing** (OIDC): the workflow mints a short-lived credential
from its `id-token: write` permission, so no npm token exists anywhere — not in the repo, not in
the cluster. npm also generates a provenance attestation automatically, since this is a public
package built from a public repo.

It lives in Actions rather than in Tektonic's own Tekton pipeline because npm only accepts
GitHub Actions, GitLab CI/CD and CircleCI as OIDC issuers; a self-hosted cluster cannot be a
trusted publisher (npm lists self-hosted runner support as planned). Everything else — test,
build, SBOM and vulnerability scan — still runs in Tekton on push and pull request.

### Cutting a release

1. Bump `version` in `package.json`, commit, and push to `main`.
2. Tag the commit `vX.Y.Z` and push the tag. The workflow refuses to publish when the tag does
   not match the package version, re-runs `npm test` and `npm run build`, and is a no-op if that
   version is already on the registry — so re-running a release is safe.

### One-time setup

Trusted publishing is configured on a package that **already exists** — `npm trust` requires
that too — so the very first publish is manual, and it needs an interactive 2FA challenge:

```bash
npm login                                    # a 2FA session, valid for two hours
npm publish --access public --otp=123456     # first release only; code from your authenticator
```

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
