# The `tektonic` CLI

Installing `@pfenerty/tektonic` puts a `tektonic` binary on your `PATH` (via `npx tektonic`, or
directly from `node_modules/.bin`). It drives *your* project definition — the file that
constructs a `TektonicProject` — so synthesis and drift-checking do not have to be reinvented in
every consumer's Makefile.

```
tektonic synth [entry] [--outdir <dir>]   Run the project entrypoint, writing its manifests
tektonic check [entry]                    Synthesize to a temp dir and diff against the committed output
tektonic graph [entry] [--format text|mermaid]
                                          Render the task DAG of each triggered pipeline
tektonic lint [paths...]                  Lint script files (shellcheck / nu-check / py_compile)
```

## The entrypoint

Every command runs your project entrypoint in a child process, exactly as `node <entry>` would.
It is resolved in this order:

1. the path given on the command line — `tektonic check .tektonic/pipeline.ts`
2. `"tektonic": { "entry": "..." }` in the nearest `package.json`
3. conventional paths: `tektonic.ts`, `tektonic.config.ts`, `.tektonic/pipeline.ts`,
   `.tektonic/main.ts`, `.tektonic/index.ts`, and their `.js` equivalents

Entrypoints run on plain `node`, which strips the types from a `.ts` file itself — no loader
is installed, probed for or required. That needs Node 22.18 or newer, and an entrypoint written
in erasable syntax: `enum`, parameter properties and `namespace` cannot be stripped. For either
case, name a runner with `"tektonic": { "runner": "npx tsx" }` and it is used verbatim.

## `check` — drift detection

`check` synthesizes into a temporary directory and compares it, file by file, with the committed
output directory:

| Finding | Meaning |
|---------|---------|
| `stale` | the committed file's content differs from what the project emits |
| `missing` | the project emits a file that was never committed |
| `orphan` | a committed file the project no longer emits |

It exits non-zero if there is any of the three. Orphans are the reason it re-synthesizes
elsewhere rather than synthesizing in place and reading `git status`: a manifest the project
stopped emitting stays committed, and the cluster keeps applying it.

```bash
tektonic check || { echo "run 'tektonic synth' and commit"; exit 1; }
```

Redirection is invisible to the emitted YAML — `repoRelativePath` still follows the *declared*
`outdir`, so PAC task annotations are byte-identical whether synthesis went to `.tekton/` or to a
temp directory. Consumers no longer need an outdir environment variable threaded through their
project definition to make a drift check possible.

### In a Tekton task

`check` is the whole body of a CI drift-check step:

```typescript
new Task({
  name: 'tekton-check',
  steps: [{
    name: 'check',
    image: nodeImage,
    script: sh`
      set -e
      npm ci
      npx tektonic check
    `,
  }],
});
```

Note the plain `set -e` + non-zero exit: hand-rolled drift checks that call `exit 1` from inside
a nushell body have been swallowed by the exit-code contract and reported green on drift. See
[scripting.md](scripting.md).

## `graph` — review the DAG

```
$ tektonic graph
npm-push [push]
  first:
    - git-clone
  after git-clone:
    - set-status-pending-npm-push
  after set-status-pending-npm-push:
    - anchore-scan
    - test-npm
  finally:
    - reconcile-status-npm-push
```

Tasks are grouped by dependency level; `?` marks a task carrying a `when` guard. `--format
mermaid` emits a flowchart for pasting into a PR or a docs page (gated tasks render as
hexagons). Like `check`, `graph` synthesizes to a temp directory and never touches committed
output.

## `lint`

Walks the given paths (default: the working directory) for `.sh`, `.bash`, `.nu` and `.py` files
and runs each language's linter — `shellcheck`, `nu-check`, `py_compile`. `node_modules`,
`dist` and dotted directories are skipped. A linter that is not installed is reported and
skipped rather than failing the run, so this is safe in any environment.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | success |
| `1` | drift found, entrypoint failed, or lint failures |
| `2` | usage error (no command, unknown command, bad `--format`) |
