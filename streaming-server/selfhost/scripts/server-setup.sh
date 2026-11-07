#!/bin/bash
# One-time setup of the radio VM (Ubuntu 24.04, as the `ubuntu` user). Safe to re-run. From a Mac:
#
#   ssh ubuntu@<ip> 'curl -fsSL https://raw.githubusercontent.com/thehimmat/google-home-radiocaster/main/streaming-server/selfhost/scripts/server-setup.sh | bash -s -- <ip-with-dashes>.sslip.io'
#
# The argument is the name Caddy gets a Let's Encrypt certificate for; <ip-with-dashes>.sslip.io
# resolves to the VM with no DNS setup. stream.atthebunga.com is separate (README.md, "Cutover").
set -euo pipefail
site=${1:?usage: server-setup.sh <site-domain>}
branch=${RADIO_BRANCH:-main}
repo=/opt/radio
dir=$repo/streaming-server/selfhost
hls=/srv/radio/hls

echo "== packages and automatic security updates"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get -y -qq full-upgrade
sudo DEBIAN_FRONTEND=noninteractive apt-get -y -qq install docker.io docker-compose-v2 git unattended-upgrades
# Security updates install daily; a kernel update reboots at 04:45 UTC (kosh-db uses 04:30), and the
# stack restarts itself. Listeners hear about a minute of silence.
sudo tee /etc/apt/apt.conf.d/52radio-unattended >/dev/null <<'CONF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:45";
CONF
sudo systemctl enable --now unattended-upgrades docker
sudo usermod -aG docker ubuntu # takes effect from the next SSH login

echo "== firewall: ports 80 and 443 (Oracle's image rejects everything but SSH)"
for port in 443 80; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    reject=$(sudo iptables -L INPUT --line-numbers | awk '/REJECT/ {print $1; exit}')
    sudo iptables -I INPUT "${reject:-1}" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  fi
done
if command -v netfilter-persistent >/dev/null; then sudo netfilter-persistent save >/dev/null; fi

echo "== swap (1 GB, a cushion for FFmpeg spikes)"
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap -q /swapfile && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

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
    echo "SITE_ADDRESS=$site"
    echo "HLS_DIR=$hls"
    echo "MAX_ENCODERS=3"
  } >> "$env_file"
else
  sed -i "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$site|" "$env_file"
fi
install -d -m 700 "$dir/certs"

echo "== stack"
# sg: the docker group from usermod above isn't in this login's groups yet.
sg docker -c "sh $dir/scripts/deploy.sh radio"
echo
echo "Done. Try it: https://$site/stations"
