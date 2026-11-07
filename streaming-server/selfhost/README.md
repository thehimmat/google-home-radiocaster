# Streaming server on Oracle

The streaming server's home after Fly.io: one container, `radio` (the image built from
`streaming-server/`), running on `kosh-db` next to gurmukhi-kosh's stack (its `selfhost/`). A second
VM would go over Always Free's 200 GB of block storage, which kosh-db's disk uses in full, so this
shares that VM and its Caddy.

- **Server:** Oracle VM `kosh-db` (Ashburn, Ampere A1, 4 OCPU / 24 GB, Ubuntu 24.04), `141.148.39.45`.
- **Code and settings on the server:** `/opt/radio` (main). Settings in
  `/opt/radio/streaming-server/selfhost/.env` (mode 600, gitignored). HLS segments and status
  history in `/srv/radio/hls`.
- **Routing:** kosh's gateway owns ports 80 and 443 and reaches `radio:3001` over the `radio-edge`
  Docker network, which is all the two stacks share. The site is gurmukhi-kosh's
  `selfhost/sites/stream.caddy`, so a routing change is a PR there.
- **Two ways in:**
  - `https://radio.141-148-39-45.sslip.io`: Let's Encrypt, not through Cloudflare. For testing before
    cutover, and to rule Cloudflare in or out when chasing a problem.
  - `https://stream.atthebunga.com`: through Cloudflare, with the same Origin CA certificate and
    Authenticated Origin Pulls as kosh's sites, so only Cloudflare reaches it on that name.

| File | What it does |
|---|---|
| `docker-compose.yml` | `radio` (port 3001, on localhost only), project name `radio` |
| `scripts/server-setup.sh` | One-time (re-runnable) setup: code, HLS folder, `.env`, stack |
| `scripts/deploy.sh` | Update to main, pull the image, start, smoke test. The deploy key runs nothing else |
| `scripts/smoke.sh` | Checks a server as a listener would: `/stations` lists the station and `/stream` carries AAC frames |

`src/selfhost.test.ts` tests `deploy.sh`, `smoke.sh` and the compose file. CI also runs shellcheck
and validates the Compose file.

## Setup

One command per step, from your Mac.

**1. Resize kosh-db** (Oracle console → Compute → Instances → kosh-db → Edit → shape): 4 OCPU, 24 GB,
which is all of Always Free's A1 allowance. **This reboots the VM**, so kosh's sites are down for a
few minutes.

**2. Give the gateway the new site:** merge the gurmukhi-kosh PR that adds `sites/stream.caddy` and the
`radio-edge` network. Its deploy applies them, recreating the gateway (a few seconds).

**3. Set it up** (clones the code, starts the stack):

```sh
ssh ubuntu@141.148.39.45 'curl -fsSL https://raw.githubusercontent.com/thehimmat/google-home-radiocaster/main/streaming-server/selfhost/scripts/server-setup.sh | bash'
```

It ends with `smoke.sh`'s three lines. If the image pull is `denied`, the GHCR package is private:
GitHub → your profile → Packages → `google-home-radiocaster/streaming-server` → Package settings →
Change visibility → Public.

**4. Check it from outside**, then cast to the Nest Hub through it:

```sh
sh streaming-server/selfhost/scripts/smoke.sh https://radio.141-148-39-45.sslip.io
```

In `src/config.local.ts`, point Golden Temple at the VM for this machine only, cast, and listen for a
while. Remove the override afterwards.

```ts
export const stations: LocalConfig['stations'] = {
  "Golden Temple": { url: "https://radio.141-148-39-45.sslip.io/golden-temple/stream", contentType: "audio/aac" },
};
```

**5. R2 archiving** (optional; Fly's secrets can't be read back). Make an R2 API token (Cloudflare →
R2 → Manage API tokens, Object Read & Write, the radio bucket only), then enter the four values when
prompted:

```sh
ssh -t ubuntu@141.148.39.45 'cd /opt/radio/streaming-server/selfhost && for k in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do read -rsp "$k: " v && echo && sed -i "/^$k=/d" .env && echo "$k=$v" >> .env; done && docker compose up -d --wait'
```

**6. Deploys from GitHub.** A key that can run `deploy.sh` and nothing else:

```sh
ssh-keygen -t ed25519 -N "" -C github-deploy-radio -f ~/.ssh/radio-deploy
```

```sh
echo "restrict,command=\"sh /opt/radio/streaming-server/selfhost/scripts/deploy.sh\" $(cat ~/.ssh/radio-deploy.pub)" | ssh ubuntu@141.148.39.45 'cat >> ~/.ssh/authorized_keys'
```

Then in this repo, Settings → Secrets and variables → Actions:
- Variable `DEPLOY_HOST` = `ubuntu@141.148.39.45`
- Secret `DEPLOY_SSH_KEY`: `pbcopy < ~/.ssh/radio-deploy`
- Secret `DEPLOY_KNOWN_HOSTS`: `ssh-keygen -F 141.148.39.45 | grep -v '^#' | pbcopy`

Run Actions → "Deploy streaming server to Oracle" → Run workflow once to check it.

## Cutover

1. **DNS:** Cloudflare → atthebunga.com → DNS → the `stream` record (a CNAME to Fly today). Change
   it to an **A record**, `141.148.39.45`, still **proxied**. Takes effect in seconds.
2. **Check:** the response should come from Caddy, not Fly:
   ```sh
   curl -sI https://stream.atthebunga.com/health | grep -iE '^(HTTP|fly-request-id)'
   ```
   Expect `HTTP/2 200` and no `fly-request-id`. Then `sh streaming-server/selfhost/scripts/smoke.sh https://stream.atthebunga.com`,
   and cast normally. UptimeRobot needs no change.
3. **Turn on the listener check**, so `/health` and `/history` say whether gaps come from the source,
   from us, or from delivery (Caddy, Cloudflare, the network):
   ```sh
   ssh ubuntu@141.148.39.45 'cd /opt/radio/streaming-server/selfhost && sed -i "/^LISTENER_CHECK_URL=/d" .env && echo LISTENER_CHECK_URL=https://stream.atthebunga.com >> .env && docker compose up -d --wait'
   ```
   To tell Cloudflare apart from the rest, point it at `https://radio.141-148-39-45.sslip.io` for a few days
   instead and compare.
4. **Status history (optional):** the 30-day log lives on Fly's volume. To keep it, before scaling
   Fly down:
   ```sh
   cd streaming-server && flyctl ssh sftp get /data/hls/_status-history.jsonl /tmp/history.jsonl && scp /tmp/history.jsonl ubuntu@141.148.39.45:/srv/radio/hls/_status-history.jsonl && ssh ubuntu@141.148.39.45 'cd /opt/radio/streaming-server/selfhost && docker compose restart radio'
   ```

**Rollback:** set the `stream` record back to a CNAME to `atthebunga-radio.fly.dev`, proxied. Fly
keeps running and deploying until it's retired.

**Retire Fly after a stable week:** `flyctl scale count 0 -a atthebunga-radio`, delete
`.github/workflows/fly-deploy.yml` and the `FLY_API_TOKEN` secret, and later `flyctl apps destroy
atthebunga-radio`.

## Day to day

```sh
# Logs
ssh ubuntu@141.148.39.45 'cd /opt/radio/streaming-server/selfhost && docker compose logs --tail 100 radio'

# CPU and memory (watch this when raising MAX_ENCODERS)
ssh ubuntu@141.148.39.45 'docker stats --no-stream'

# More simultaneous encodes: edit MAX_ENCODERS in .env, then
ssh ubuntu@141.148.39.45 'cd /opt/radio/streaming-server/selfhost && docker compose up -d --wait'

# Roll back to an earlier image (commit SHAs are the tags): RADIO_TAG=<sha> in .env, then up -d as
# above. Remove the line to follow latest again.
```

Security updates install daily, and a kernel update reboots the VM at 04:30 UTC, for kosh and the radio
together. Listeners hear about a minute of silence. A deploy of kosh that recreates its gateway also
drops listeners for a moment; a plain kosh or search deploy only reloads Caddy.

**Oracle's idle reclaim:** Oracle stops Always Free VMs that look idle for 7 days (low CPU, network
and memory). Continuous encoding keeps this one busy, but see gurmukhi-kosh's
`selfhost/README.md`, "Oracle's idle-instance reclaim", for the Pay As You Go option.
