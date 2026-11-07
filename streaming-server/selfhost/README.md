# Streaming server on Oracle

The streaming server's home after Fly.io: an Always Free Oracle VM in the same account as `kosh-db`
(gurmukhi-kosh's `selfhost/`, which this copies). Two containers: `radio` (the image built from
`streaming-server/`) and Caddy in front of it.

- **Server:** Oracle VM `radio` (Ashburn, Ampere A1, 2 OCPU / 12 GB, Ubuntu 24.04). Its IP is
  `<ip>` below, and `<ip-dashes>` is the same with dashes (`129-80-1-2`).
- **Code and settings on the server:** `/opt/radio` (main). Settings in
  `/opt/radio/streaming-server/selfhost/.env` (mode 600, gitignored). HLS segments and status
  history in `/srv/radio/hls`.
- **Two ways in:**
  - `https://<ip-dashes>.sslip.io`: Let's Encrypt, not through Cloudflare. For testing before cutover,
    and to rule Cloudflare in or out when chasing a problem.
  - `https://stream.atthebunga.com`: through Cloudflare, with the same Origin CA certificate and
    Authenticated Origin Pulls as kosh-db, so only Cloudflare reaches it on that name.

| File | What it does |
|---|---|
| `docker-compose.yml` | `radio` (port 3001, on localhost only) and `gateway` (Caddy, 80/443) |
| `Caddyfile` | The sslip.io site; imports `sites-enabled/` |
| `sites/stream.caddy` | stream.atthebunga.com. `deploy.sh` enables it once the certificates are in `certs/` |
| `scripts/server-setup.sh` | One-time (re-runnable) VM setup: updates, firewall, Docker, swap, `.env`, stack |
| `scripts/deploy.sh` | Update to main, pull the image, start, reload Caddy, smoke test. The deploy key runs nothing else |
| `scripts/smoke.sh` | Checks a server as a listener would: `/stations` lists the station and `/stream` carries AAC frames |

`src/selfhost.test.ts` tests `deploy.sh` and `smoke.sh`. CI also runs shellcheck and validates the
Compose and Caddy files.

## Setup

One command per step, from your Mac.

**1. Create the VM** (Oracle console → Compute → Instances → Create instance):
- Name `radio`. Image: Canonical Ubuntu 24.04 (the aarch64 build). Shape: VM.Standard.A1.Flex, 2 OCPU,
  12 GB.
- Networking: kosh-db's VCN and public subnet, with a public IPv4 address. That subnet's security
  list already allows 80 and 443. In a different subnet, add ingress rules for TCP 80 and 443 from
  0.0.0.0/0.
- SSH key: the same public key as kosh-db.
- If it says **out of capacity**, retry later or try another availability domain. The fallback is
  resizing kosh-db to 4 OCPU / 24 GB and running this stack there too.

**2. Set it up** (installs Docker, opens 80/443, starts the stack; about 5 minutes):

```sh
ssh ubuntu@<ip> 'curl -fsSL https://raw.githubusercontent.com/thehimmat/google-home-radiocaster/main/streaming-server/selfhost/scripts/server-setup.sh | bash -s -- <ip-dashes>.sslip.io'
```

It ends with `smoke.sh`'s three lines. If the image pull is `denied`, the GHCR package is private:
GitHub → your profile → Packages → `google-home-radiocaster/streaming-server` → Package settings →
Change visibility → Public.

**3. Check it from outside**, then cast to the Nest Hub through it:

```sh
sh streaming-server/selfhost/scripts/smoke.sh https://<ip-dashes>.sslip.io
```

In `src/config.local.ts`, point Golden Temple at the VM for this machine only, cast, and listen for a
while. Remove the override afterwards.

```ts
export const stations: LocalConfig['stations'] = {
  "Golden Temple": { url: "https://<ip-dashes>.sslip.io/golden-temple/stream", contentType: "audio/aac" },
};
```

**4. Cloudflare certificates**, copied from kosh-db, then enable stream.atthebunga.com:

```sh
ssh ubuntu@141.148.39.45 'tar -C /opt/kosh/selfhost/certs -c origin.pem origin.key cloudflare-origin-pull-ca.pem' | ssh ubuntu@<ip> 'tar -C /opt/radio/streaming-server/selfhost/certs -x'
```

```sh
ssh ubuntu@<ip> 'sh /opt/radio/streaming-server/selfhost/scripts/deploy.sh config'
```

**5. R2 archiving** (optional; Fly's secrets can't be read back). Make an R2 API token (Cloudflare →
R2 → Manage API tokens, Object Read & Write, the radio bucket only), then enter the four values when
prompted:

```sh
ssh -t ubuntu@<ip> 'cd /opt/radio/streaming-server/selfhost && for k in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do read -rsp "$k: " v && echo && sed -i "/^$k=/d" .env && echo "$k=$v" >> .env; done && docker compose up -d --wait'
```

**6. Deploys from GitHub.** A key that can run `deploy.sh` and nothing else:

```sh
ssh-keygen -t ed25519 -N "" -C github-deploy-radio -f ~/.ssh/radio-deploy
```

```sh
echo "restrict,command=\"sh /opt/radio/streaming-server/selfhost/scripts/deploy.sh\" $(cat ~/.ssh/radio-deploy.pub)" | ssh ubuntu@<ip> 'cat >> ~/.ssh/authorized_keys'
```

Then in this repo, Settings → Secrets and variables → Actions:
- Variable `DEPLOY_HOST` = `ubuntu@<ip>`
- Secret `DEPLOY_SSH_KEY`: `pbcopy < ~/.ssh/radio-deploy`
- Secret `DEPLOY_KNOWN_HOSTS`: `ssh-keygen -F <ip> | grep -v '^#' | pbcopy`

Run Actions → "Deploy streaming server to Oracle" → Run workflow once to check it.

## Cutover

1. **DNS:** Cloudflare → atthebunga.com → DNS → the `stream` record (a CNAME to Fly today). Change
   it to an **A record**, `<ip>`, still **proxied**. Takes effect in seconds.
2. **Check:** the response should come from Caddy, not Fly:
   ```sh
   curl -sI https://stream.atthebunga.com/health | grep -iE '^(HTTP|fly-request-id)'
   ```
   Expect `HTTP/2 200` and no `fly-request-id`. Then `sh streaming-server/selfhost/scripts/smoke.sh https://stream.atthebunga.com`,
   and cast normally. UptimeRobot needs no change.
3. **Status history (optional):** the 30-day log lives on Fly's volume. To keep it, before scaling
   Fly down:
   ```sh
   cd streaming-server && flyctl ssh sftp get /data/hls/_status-history.jsonl /tmp/history.jsonl && scp /tmp/history.jsonl ubuntu@<ip>:/srv/radio/hls/_status-history.jsonl && ssh ubuntu@<ip> 'cd /opt/radio/streaming-server/selfhost && docker compose restart radio'
   ```

**Rollback:** set the `stream` record back to a CNAME to `atthebunga-radio.fly.dev`, proxied. Fly
keeps running and deploying until it's retired.

**Retire Fly after a stable week:** `flyctl scale count 0 -a atthebunga-radio`, delete
`.github/workflows/fly-deploy.yml` and the `FLY_API_TOKEN` secret, and later `flyctl apps destroy
atthebunga-radio`.

## Day to day

```sh
# Logs
ssh ubuntu@<ip> 'cd /opt/radio/streaming-server/selfhost && docker compose logs --tail 100 radio'

# CPU and memory (watch this when raising MAX_ENCODERS)
ssh ubuntu@<ip> 'docker stats --no-stream'

# More simultaneous encodes: edit MAX_ENCODERS in .env, then
ssh ubuntu@<ip> 'cd /opt/radio/streaming-server/selfhost && docker compose up -d --wait'

# Roll back to an earlier image (commit SHAs are the tags): RADIO_TAG=<sha> in .env, then up -d as
# above. Remove the line to follow latest again.
```

Security updates install daily, and a kernel update reboots the VM at 04:45 UTC (kosh-db's is
04:30). Listeners hear about a minute of silence.

**Oracle's idle reclaim:** Oracle stops Always Free VMs that look idle for 7 days (low CPU, network
and memory). Continuous encoding keeps this one busy, but see gurmukhi-kosh's
`selfhost/README.md`, "Oracle's idle-instance reclaim", for the Pay As You Go option.
