# Dev Environment

This project uses **[Flox](https://flox.dev)** for environment management. `node`, `npm`, and all other project tooling are **only available inside the activated Flox environment**.

When running CLI commands non-interactively (e.g. from a shell that was not started with `flox activate`), prefix every command with `flox activate --`:

```bash
flox activate -- npm test
flox activate -- npm run build
flox activate -- npm run synth
```

The environment is defined in `.flox/env/manifest.toml` and currently provides:
- Node.js 24.13.0 (npm bundled)
- Beads (`bd`) — AI-native issue tracker CLI
- Repomix — codebase packer for AI context

## Common Commands

| Action | Command |
|---|---|
| Run tests | `flox activate -- npm test` |
| Build (compile TS) | `flox activate -- npm run build` |
| Synthesize manifests | `flox activate -- npm run synth` |
| Install dependencies | `flox activate -- npm install` |
| Watch mode tests | `flox activate -- npm run test:watch` |
| List issues | `flox activate -- bd list` |
| Update codebase snapshot | `flox activate -- repomix` |

## Issue Tracking

Beads (`bd`) is configured at `.beads/`. Use it for ALL task tracking — no markdown TODOs.

```bash
bd ready                              # find available work
bd create --title="..." --type=task   # create before starting work
bd update <id> --status=in_progress   # claim it
bd close <id>                         # mark done
```

Issue types: `bug`, `feature`, `task`, `epic`, `chore`
Priorities: `0`=critical, `1`=high, `2`=medium (default), `3`=low, `4`=backlog

## Session Completion

Work is NOT complete until pushed. Before ending a session:

1. Close finished issues, file issues for remaining work
2. Run quality gates if code changed (`flox activate -- npm test && flox activate -- npm run build`)
3. Push:
   ```bash
   git pull --rebase && git push
   ```

## Codebase Context

`repomix-output.xml` is a packed snapshot of the entire codebase used as AI context. It is not tracked in git. Regenerate it after significant changes:

```bash
flox activate -- repomix
```

## Using Tektonic

See [`docs/agent-guide.md`](docs/agent-guide.md) for a full guide on creating pipelines with this library.
