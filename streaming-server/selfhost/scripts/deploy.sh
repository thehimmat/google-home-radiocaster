#!/bin/sh
# Deploys the streaming server on kosh-db. It's the forced command of GitHub Actions' deploy key
# (README.md, "Deploys"), which sends the target as its SSH command:
#
#   ssh ubuntu@<ip> radio     # pull the latest image, then apply config
#   ssh ubuntu@<ip> config    # only this folder's config (the compose file)
#
# Updates /opt/radio to main, brings the stack up (waiting for health checks) and runs smoke.sh.
# Routing lives in kosh's gateway (gurmukhi-kosh, selfhost/sites/stream.caddy), not here.
set -eu
target=${SSH_ORIGINAL_COMMAND:-${1:-}}
case "$target" in
  radio | config) ;;
  *)
    echo "usage: deploy.sh radio|config" >&2
    exit 2
    ;;
esac
echo "deploy $target"
[ -z "${RADIO_DEPLOY_DRY_RUN:-}" ] || exit 0

cd "$(dirname "$0")/.."
git fetch -q origin main
git checkout -q -B main origin/main

[ "$target" = config ] || docker compose pull -q radio
docker compose up -d --quiet-pull --wait
docker image prune -f >/dev/null
docker compose ps --format '{{.Service}}: {{.Status}}'
sh scripts/smoke.sh http://127.0.0.1:3001
