# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

## Cross-Repo Planning

`tektonic` (`@pfenerty/tektonic`) is the TypeScript library consumed by `ocidex` (`make tekton-synth`) and `homelab/tekton-pipelines/`. It sits in the middle of the dependency chain: `apko-cicd → tektonic → ocidex/homelab`. Cross-cutting initiatives that span multiple repos are tracked in `~/code/common/` (issue prefix: `plan`).

- `bd list` here shows only this repo's issues — cross-repo hydration is not yet implemented in beads
- **Unified view:** `flox activate -d ~/code/ocidex -- nu ~/code/common/bd-all.nu`
- To create a cross-repo parent epic: `cd ~/code/common && bd create --title="..." --type=epic`
- When a local issue is part of a cross-repo initiative: `bd update <id> --notes "Parent epic: plan/<id>"`
- Changes here typically propagate downstream: bump the npm dep in `ocidex` and `homelab/tekton-pipelines/`, then re-synth

