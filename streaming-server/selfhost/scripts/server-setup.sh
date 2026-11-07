#!/bin/bash
# One-time setup of the radio stack on kosh-db, as the `ubuntu` user. Safe to re-run. From a Mac:
#
#   ssh ubuntu@<ip> 'curl -fsSL https://raw.githubusercontent.com/thehimmat/google-home-radiocaster/main/streaming-server/selfhost/scripts/server-setup.sh | bash'
#
# Docker, the firewall, swap and security updates are already kosh's (gurmukhi-kosh,
# selfhost/scripts/server-setup.sh), and so are ports 80 and 443. This adds only the code, the
# settings and the stack.
set -euo pipefail
branch=${RADIO_BRANCH:-main}
repo=/opt/radio
dir=$repo/streaming-server/selfhost
hls=/srv/radio/hls

echo "== code ($branch)"
sudo install -d -o ubuntu -g ubuntu "$repo"
if [ -d "$repo/.git" ]; then
  git -C "$repo" fetch -q origin "$branch" && git -C "$repo" checkout -q -B "$branch" "origin/$branch"
else
  git clone -q --branch "$branch" https://github.com/thehimmat/google-home-radiocaster.git "$repo"
fi

echo "== HLS segments and status history ($hls)"
sudo install -d -o ubuntu -g ubuntu "$hls"

echo "== settings (.env, made once; R2 keys are added by hand, README.md)"
env_file=$dir/.env
if [ ! -f "$env_file" ]; then
  (umask 077 && : > "$env_file")
  {
    echo "HLS_DIR=$hls"
    echo "MAX_ENCODERS=3"
  } >> "$env_file"
fi

echo "== stack"
sh "$dir/scripts/deploy.sh" radio
echo
echo "Done. Try it: curl http://127.0.0.1:3001/stations"
