#!/bin/sh
# Deploys the streaming server on the VM. It's the forced command of GitHub Actions' deploy key
# (README.md, "Deploys"), which sends the target as its SSH command:
#
#   ssh ubuntu@<ip> radio     # pull the latest image, then apply config
#   ssh ubuntu@<ip> config    # only this folder's config (compose file, Caddy)
#
# Updates /opt/radio to main, enables stream.atthebunga.com once the Cloudflare certificates are in
# certs/, brings the stack up (waiting for health checks), reloads Caddy and runs smoke.sh.
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
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"

if [ -z "${RADIO_DEPLOY_DRY_RUN:-}" ]; then
  git fetch -q origin main
  git checkout -q -B main origin/main
fi

mkdir -p sites-enabled
if [ -f certs/origin.pem ] && [ -f certs/origin.key ] && [ -f certs/cloudflare-origin-pull-ca.pem ]; then
  cp sites/stream.caddy sites-enabled/stream.caddy
else
  rm -f sites-enabled/stream.caddy
fi
[ -z "${RADIO_DEPLOY_DRY_RUN:-}" ] || exit 0

[ "$target" = config ] || docker compose pull -q radio
docker compose up -d --quiet-pull --wait
docker compose exec -T gateway caddy reload --config /etc/caddy/Caddyfile
docker image prune -f >/dev/null
docker compose ps --format '{{.Service}}: {{.Status}}'
sh scripts/smoke.sh http://127.0.0.1:3001
