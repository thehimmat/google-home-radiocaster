#!/bin/bash
# Stops and removes the Radio Caster launchd agent installed by install-agent.sh.
set -euo pipefail

LABEL="com.atthebunga.radiocaster"
AGENTS_DIR="${RADIOCASTER_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$AGENTS_DIR/$LABEL.plist"

if command -v launchctl >/dev/null; then
  DOMAIN="gui/$(id -u)"
  if launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null; then
    echo "Unloaded $LABEL from $DOMAIN"
  else
    echo "$LABEL was not loaded"
  fi
fi

if [[ -f "$PLIST" ]]; then
  rm -f "$PLIST"
  echo "Removed $PLIST"
else
  echo "No plist at $PLIST"
fi
