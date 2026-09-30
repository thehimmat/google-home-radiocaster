#!/bin/bash
# Installs the Radio Caster scheduler as a launchd user agent on macOS.
#
#   npm run install-agent            render the plist and (re)load it
#   npm run install-agent -- --render-only
#                                    just write the plist, don't touch launchctl
#
# Environment (optional):
#   RADIOCASTER_NODE               node binary to bake into the plist
#                                  (default: `node` on PATH)
#   RADIOCASTER_LAUNCH_AGENTS_DIR  where to write the plist
#                                  (default ~/Library/LaunchAgents)
set -euo pipefail

LABEL="com.atthebunga.radiocaster"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_ROOT/deploy/$LABEL.plist.example"
AGENTS_DIR="${RADIOCASTER_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$AGENTS_DIR/$LABEL.plist"

RENDER_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --render-only) RENDER_ONLY=1 ;;
    *) echo "install-agent: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

NODE="${RADIOCASTER_NODE:-$(command -v node || true)}"
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "install-agent: could not find a node binary. Install Node 18+ or set RADIOCASTER_NODE." >&2
  exit 1
fi
NODE="$(cd "$(dirname "$NODE")" && pwd)/$(basename "$NODE")"

if [[ ! -x "$REPO_ROOT/node_modules/.bin/ts-node" ]]; then
  echo "install-agent: node_modules/.bin/ts-node is missing — run 'npm install' first." >&2
  exit 1
fi

mkdir -p "$AGENTS_DIR"
# '|' as the sed delimiter since both substitutions are filesystem paths.
sed -e "s|__REPO_PATH__|$REPO_ROOT|g" -e "s|__NODE_PATH__|$NODE|g" "$TEMPLATE" > "$PLIST"
echo "Wrote $PLIST"
echo "  repo: $REPO_ROOT"
echo "  node: $NODE"

if (( RENDER_ONLY )); then
  exit 0
fi

if ! command -v launchctl >/dev/null; then
  echo "install-agent: launchctl not found — this installer only loads agents on macOS." >&2
  exit 1
fi

DOMAIN="gui/$(id -u)"
# Unload any previous copy first so a re-install picks up the new plist.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Loaded $LABEL into $DOMAIN"
echo
echo "  status: launchctl print $DOMAIN/$LABEL | head -20"
echo "  logs:   tail -f ~/Library/Logs/radiocaster/radiocaster.log"
echo "  remove: npm run uninstall-agent"
