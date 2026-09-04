#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Prepares a fresh remote container so tests, linters, and the beads (bd)
# issue tracker work from the first turn:
#   1. installs npm dependencies (Puppeteer downloads its Chrome as part of this)
#   2. installs the bd CLI if it is missing
#   3. clones the beads Dolt database from the git remote on first run,
#      or pulls the latest issues on later runs
#
# It only runs in remote sessions; local sessions exit immediately.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

log() { echo "[session-start] $*" >&2; }

# --- 1. Node dependencies -------------------------------------------------
# `npm install` (not `npm ci`) so the cached node_modules is reused when the
# container is restored rather than wiped and rebuilt.
log "Installing npm dependencies"
npm install --no-audit --no-fund

# --- 2. beads (bd) CLI ----------------------------------------------------
# The install script builds bd with `go install` so the embedded Dolt engine is
# available. GOBIN points at a directory already on PATH.
export GOBIN=/usr/local/bin

if ! command -v bd >/dev/null 2>&1; then
  if command -v go >/dev/null 2>&1; then
    log "Installing bd (beads)"
    curl -fsSL https://raw.githubusercontent.com/gastownhall/beads/main/scripts/install.sh | bash \
      || log "bd install script reported an error"
  else
    log "go toolchain not found; skipping bd install"
  fi
fi

# Fall back to the default go bin directory if the installer ignored GOBIN.
if ! command -v bd >/dev/null 2>&1; then
  gobin="$(go env GOPATH 2>/dev/null || echo "$HOME/go")/bin"
  if [ -x "$gobin/bd" ]; then
    ln -sf "$gobin/bd" /usr/local/bin/bd
  fi
fi

if ! command -v bd >/dev/null 2>&1; then
  log "bd is not available; beads issue tracking will be unavailable this session"
  exit 0
fi

# --- 3. beads database ----------------------------------------------------
# Dolt data is gitignored, so a fresh clone has no database. sync.remote in
# .beads/config.yaml points at refs/dolt/data on the git remote.
chmod 700 .beads

# Silences the "beads.role not configured" warning on every bd command.
if ! git config beads.role >/dev/null 2>&1; then
  git config beads.role maintainer
fi

if [ -d .beads/embeddeddolt ] || [ -d .beads/dolt ]; then
  log "Pulling latest beads issues"
  bd dolt pull || log "bd dolt pull failed; continuing with the cached database"
else
  log "Bootstrapping beads database from remote"
  bd bootstrap --non-interactive || log "bd bootstrap failed; run 'bd bootstrap' manually"
fi

log "Done. $(bd version 2>/dev/null | head -1)"
