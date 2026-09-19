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
├── charts/
│   └── tekton-infra.chart.ts     # trigger infrastructure chart
└── lib/
    ├── core/                     # primitives, orchestrators, extension interfaces
    │   ├── param.ts  workspace.ts  result.ts
    │   ├── task.ts               # TaskDef (aka Task)
    │   ├── pipeline.ts  git-pipeline.ts  pipeline-task.ts
    │   ├── tekton-project.ts  pac-project.ts      # the two synthesizers
    │   ├── hub-task-ref.ts  trigger-events.ts
    │   └── cache-backend.ts  status-reporter.ts   # extension interfaces
    ├── script/                   # ScriptLanguage plugins (sh/bash/nushell/python) + from-file
    ├── cache/                    # PvcBackend, GcsBackend, shared helpers
    ├── triggers/                 # VcsProvider + GitHub triggers
    └── reporters/                # GitHubStatusReporter
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

Trusted publishing is configured on an **existing** package, so the very first publish is manual:

```bash
npm login                       # a 2FA session, valid for two hours
npm publish --access public     # first release only
```

Then, on npmjs.com → the package → Settings → Trusted Publishers, add a GitHub Actions publisher
for repository `pfenerty/tektonic` with workflow `publish.yml`. Every later release goes through
the tag.

> Classic automation tokens are not an option: npm revoked all of them in December 2025, and
> granular tokens with write access now expire after at most 90 days.

## Code conventions

- TypeScript strict mode
- vitest for testing
- cdk8s patterns for Kubernetes resource generation
- TSDoc comments on all public API surface
