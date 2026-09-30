#!/bin/bash
# Entry point launchd runs for the Radio Caster scheduler.
#
# Rotates the log if it has grown past the limit, then execs the scheduler
# with stdout/stderr appended to the log. Doing the redirect here (rather than
# via launchd's StandardOutPath) is what makes rotation safe: launchd would
# otherwise keep the old inode open across a rename.
#
# Environment (all optional):
#   RADIOCASTER_NODE           node binary to use (default: `node` on PATH)
#   RADIOCASTER_LOG_DIR        default ~/Library/Logs/radiocaster
#   RADIOCASTER_LOG_MAX_BYTES  rotate when the log exceeds this (default 5 MB)
#   RADIOCASTER_LOG_KEEP       rotated generations to keep (default 3)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${RADIOCASTER_NODE:-$(command -v node || true)}"
LOG_DIR="${RADIOCASTER_LOG_DIR:-$HOME/Library/Logs/radiocaster}"
LOG_MAX_BYTES="${RADIOCASTER_LOG_MAX_BYTES:-5242880}"
LOG_KEEP="${RADIOCASTER_LOG_KEEP:-3}"
LOG="$LOG_DIR/radiocaster.log"

if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "radiocaster-agent: node not found (RADIOCASTER_NODE='${RADIOCASTER_NODE:-}')" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

# `wc -c` rather than `stat`, whose flags differ between macOS and Linux.
if [[ -f "$LOG" ]] && (( $(wc -c < "$LOG") > LOG_MAX_BYTES )); then
  for (( i = LOG_KEEP - 1; i >= 1; i-- )); do
    [[ -f "$LOG.$i" ]] && mv -f "$LOG.$i" "$LOG.$((i + 1))"
  done
  mv -f "$LOG" "$LOG.1"
fi

exec >> "$LOG" 2>&1
cd "$REPO_ROOT"
echo "=== radiocaster-agent starting $(date) (node: $NODE) ==="
exec "$NODE" node_modules/.bin/ts-node src/index.ts
