#!/usr/bin/env bash
# SessionStart hook — makes a fresh checkout able to run bd, the tests and the build.
#
# Written for Claude Code on the web, where the container is a cold clone: no Flox,
# no node_modules, no bd on PATH, and no Dolt database (.beads/embeddeddolt/ is
# gitignored, so issue state arrives only as .beads/issues.jsonl).
#
# Locally this is close to a no-op: Flox already supplies bd and node, so every
# install step is skipped and only `bd prime` runs.
#
# Idempotent and non-interactive. Safe to re-run.
set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$PROJECT_DIR" || exit 0

# Never fail the session over setup. Each step reports and moves on.
note() { echo "[session-start] $*" >&2; }

# ── bd (beads) ───────────────────────────────────────────────────────────────
# Go module path is still github.com/steveyegge/beads even though the repo moved
# to gastownhall/beads. CGO + the gms_pure_go tag are what make the binary
# embedded-Dolt capable; without them bd can only talk to an external sql-server.
# There are no prebuilt release assets to fetch, so `go install` is the only path.
GOBIN_DIR="$(go env GOBIN 2>/dev/null || true)"
[ -n "$GOBIN_DIR" ] || GOBIN_DIR="$(go env GOPATH 2>/dev/null)/bin"

if ! command -v bd >/dev/null 2>&1 && [ -x "$GOBIN_DIR/bd" ]; then
  export PATH="$PATH:$GOBIN_DIR"
fi

if ! command -v bd >/dev/null 2>&1; then
  if command -v go >/dev/null 2>&1; then
    note "installing bd (go install, a few minutes on a cold container)..."
    if CGO_ENABLED=1 GOFLAGS="${GOFLAGS:+$GOFLAGS }-tags=gms_pure_go" \
         go install github.com/steveyegge/beads/cmd/bd@latest 2>&1 | tail -3 >&2; then
      export PATH="$PATH:$GOBIN_DIR"
      note "bd installed to $GOBIN_DIR/bd"
    else
      note "bd install failed — issue tracking unavailable this session"
    fi
  else
    note "go not available — skipping bd install"
  fi
fi

if command -v bd >/dev/null 2>&1 && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"\$PATH:$GOBIN_DIR\"" >> "$CLAUDE_ENV_FILE"
fi

# ── Beads database ───────────────────────────────────────────────────────────
# .beads/embeddeddolt/ is gitignored, so a fresh clone has no database and every
# bd command errors with "no beads database found". Rebuild it from the JSONL
# that IS committed. Guarded on the database being absent, so a machine that
# already has one (a local checkout) is never touched.
if command -v bd >/dev/null 2>&1; then
  chmod 700 .beads 2>/dev/null || true
  if [ ! -d .beads/embeddeddolt ] && [ ! -d .beads/dolt ]; then
    note "no local beads database — rebuilding from .beads/issues.jsonl"
    # --skip-agents/--skip-hooks stop bd init from rewriting CLAUDE.md, AGENTS.md,
    # .claude/settings.json and the git hooks. --from-jsonl hydrates from the
    # committed issues.jsonl in the same step.
    _head_before="$(git rev-parse HEAD 2>/dev/null || true)"
    if bd init --prefix tektonic \
               --skip-agents --skip-hooks --from-jsonl \
               --init-if-missing --non-interactive --quiet >/dev/null 2>&1; then
      note "beads database rebuilt from $(wc -l < .beads/issues.jsonl) issues"
    else
      note "bd init failed — issue tracking unavailable this session"
    fi
    # bd init commits, and edits .beads/config.yaml (reindent + a sync.remote line),
    # even with the --skip-* flags above. A session hook must do neither: undo its
    # commit and restore the tracked config it rewrote. Anything the developer had
    # staged or modified is left exactly as it was.
    if [ -n "$_head_before" ] \
       && [ "$_head_before" != "$(git rev-parse HEAD 2>/dev/null)" ] \
       && git log -1 --pretty=%s 2>/dev/null | grep -q '^bd init:'; then
      git reset --mixed "$_head_before" >/dev/null 2>&1 || true
      note "reverted the commit bd init made"
    fi
    git checkout -- .beads/config.yaml >/dev/null 2>&1 || true
  fi
fi

# ── Node dependencies ────────────────────────────────────────────────────────
# Remote only: locally Flox supplies node and the tree is usually already warm.
# `npm install` (not `ci`) so the container snapshot taken after this hook is
# reusable across sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && [ ! -d node_modules ]; then
  if command -v npm >/dev/null 2>&1; then
    note "installing npm dependencies..."
    npm install --no-audit --no-fund >/dev/null 2>&1 \
      && note "npm dependencies installed" \
      || note "npm install failed"
  fi
fi

# ── Issue-tracker context ────────────────────────────────────────────────────
# Replaces the bare `bd prime` this hook used to be; stdout becomes session context.
if command -v bd >/dev/null 2>&1; then
  bd prime 2>/dev/null || true
fi

exit 0
