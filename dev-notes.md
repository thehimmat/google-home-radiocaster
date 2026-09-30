# Radio Caster — Dev Notes

## What this does

Plays internet radio on a Google Home / Nest Hub using the Cast protocol, with
cron-based scheduling. The device's IP and name live in the gitignored
`src/config.local.ts` (see "Per-machine config" below).

---

## Architecture

```
Mac (cast-now / scheduler, or the launchd agent)
  ↓  sends LOAD with stream URL
Nest Hub (port 8009)
  ↓  GET /<station>/stream — one long-lived ADTS AAC response
stream.atthebunga.com (Fly.io, Dockerised, region sjc)
  ↓  FFmpeg transcodes; HLS segments also written to /data/hls/ for the web player
Upstream source (e.g. live.sgpc.net:8443, radio.sikhnet.com)
```

The streaming relay at `stream.atthebunga.com` is necessary because:
- Some upstream streams are on non-standard ports (8443) that the Nest Hub
  may not reach depending on router config
- Some CDNs (streamguys1.com) have TLS cert mismatches that Cast devices reject
- Shoutcast servers return HTML to browser User-Agents — the relay uses
  `WinampMPEG/5.0` to get the raw audio stream

**Two output formats**: Cast devices use `/<station>/stream`, a single
long-lived raw AAC response fanned out from one FFmpeg per station. Browsers
(the web player, via hls.js or Safari) use `/<station>`, an HLS playlist of
4-second segments. HLS was originally the only path because Railway killed any
response open longer than 5 minutes; Fly.io has no such limit, so Cast moved to
the simpler raw stream and HLS stayed for the web player and the R2 archiver.

---

## Streaming server (streaming-server/)

Deployed on Fly.io (app `atthebunga-radio`, config in `streaming-server/fly.toml`)
via the Dockerfile in `streaming-server/`. FFmpeg is installed in the container.
One HLS FFmpeg process runs per station at boot, writing segments to
`HLS_ROOT` (`/data/hls`, a persistent Fly volume so segments survive restarts).
A separate per-station FFmpeg for `/stream` is spawned lazily on the first
Cast listener and kept alive for 60 s after the last one leaves.

Deploys are automatic: `.github/workflows/fly-deploy.yml` runs `flyctl deploy`
on every push to `main` that touches `streaming-server/`. Manual deploy:
`cd streaming-server && flyctl deploy`.

`fly.toml` gotchas:
- `auto_stop_machines = "off"` and `min_machines_running = 1` — autostop would
  kill the FFmpeg processes between listener sessions.
- `[[mounts]] hls_data → /data/hls` — without the volume a restart wipes the
  segments and Cast devices get 404s mid-playlist.

Custom domain: `stream.atthebunga.com` (CNAME → the Fly app, DNS via Vercel;
cert issued with `flyctl certs add`).

Routes (`streaming-server/src/app.ts`):
- `GET /health` — per-station `live` / `source-down` / `error`; returns 503 only
  when a station is in `error` (our pipeline), not when the source is down
- `GET /stations` — station metadata plus `hlsPath` / `streamPath` for the web player
- `HEAD /:station` — returns `Content-Type: application/x-mpegURL` immediately
- `GET /:station` — serves the rewritten M3U8 playlist (segment URLs rewritten to absolute HTTPS)
- `GET /:station/stream` — raw ADTS AAC, shared FFmpeg per station (Cast uses this)
- `GET /:station/:file.ts` — serves individual HLS segment files
- Static files from `streaming-server/public/` (cast receiver skin, logos)

Optional R2 archiving: set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET` as Fly secrets and each station's segments
are uploaded as they're written (24 h lifecycle rule on the bucket). Nothing
reads them back yet — see #5.

To add a station:
1. Add an entry to `STATIONS` in `streaming-server/src/server.ts`
2. Add an entry to `stations` in `src/config.ts` pointing to
   `https://stream.atthebunga.com/<slug>/stream` with `contentType: "audio/aac"`
3. Push to `main` — the GitHub Action deploys to Fly

---

## Current stations

| Key in config.ts     | Relay URL                                     | Upstream                                    |
|----------------------|-----------------------------------------------|---------------------------------------------|
| Golden Temple        | stream.atthebunga.com/golden-temple/stream    | live.sgpc.net:8443 (Shoutcast, AAC+)       |
| San Jose Gurdwara    | stream.atthebunga.com/san-jose/stream         | radio.sikhnet.com/proxy/channel18/live (MP3)|
| SomaFM Groove Salad  | ice1.somafm.com/groovesalad-128-mp3 (direct)  | —                                           |

---

## Per-machine config

`src/config.ts` is tracked and generic. Real device IP/name and cron times go
in `src/config.local.ts` (gitignored; copy `config.local.example.ts`).
`local-config.ts` does the merge: `schedule` replaces, `stations` merges by
key. A missing local file is fine; a broken one throws at startup rather than
silently falling back to the placeholder schedule.

---

## Always-on scheduler (launchd)

`npm run install-agent` renders `deploy/com.atthebunga.radiocaster.plist.example`
into `~/Library/LaunchAgents/` and bootstraps it. The plist runs
`deploy/radiocaster-agent.sh`, which rotates the log (5 MB, keep 3) and then
execs `node node_modules/.bin/ts-node src/index.ts`. Logs:
`~/Library/Logs/radiocaster/radiocaster.log`.

The wrapper does its own `exec >> log` instead of using launchd's
`StandardOutPath` — launchd would keep the old inode open after a rename, so
rotation would silently stop capturing output. `npm run uninstall-agent`
removes it. Both scripts are covered by `src/deploy.test.ts`, which runs them
on any POSIX host with a fake `node`.

---

## Known issues / TODO

- **OPB News / KEXP**: streamguys1.com has a TLS cert mismatch (`*.streamguys.com`
  doesn't cover `streamguys1.com`). Commented out of config until working URLs
  are found. Check opb.org and kexp.org for current stream URLs.

---

## Key debugging lessons

- **Shoutcast + browser User-Agent**: Shoutcast servers return an HTML redirect
  page to browser UAs. Use `WinampMPEG/5.0` to get raw audio.
- **probeStream timeout**: HEAD requests to streaming servers can hang if the
  server waits for an upstream connection before responding. The relay handles
  HEAD separately (instant response), and the client has a 6s timeout.
- **mDNS not available**: Router AP isolation blocks multicast. All devices use
  `deviceIp` in config to connect directly.
- **audio/aacp vs audio/aac**: Cast Default Media Receiver accepts `audio/aac`
  but not `audio/aacp`. The relay transcodes to AAC via FFmpeg.
- **Long-lived responses (historical)**: Railway's public networking killed any
  HTTP response open longer than 5 minutes, which is why HLS exists here. Fly.io
  has no such limit, so `/stream` can stay open for the whole cast.
- **Fly autostop kills FFmpeg**: with `auto_stop_machines` on, Fly stops the
  machine when no requests are in flight, taking the HLS FFmpeg processes with
  it. Must be `"off"` with `min_machines_running = 1`.
- **Ephemeral disk wipes segments**: a restart clears `/tmp`, so a Cast device
  mid-playlist gets 404s. The persistent `hls_data` volume at `/data/hls` fixes
  it, together with `-start_number` continuity on FFmpeg restart so the media
  sequence never jumps backwards.
- **HLS segment paths**: FFmpeg writes bare filenames (e.g. `seg00000.ts`) into
  the M3U8 only when spawned with `cwd` set to the output directory. Without
  `cwd`, it writes absolute filesystem paths that Cast devices can't fetch.
- **req.protocol behind the Fly proxy**: Fly terminates TLS at the edge; inside
  the container `req.protocol` is `http`. `app.set('trust proxy', true)` makes
  Express read `X-Forwarded-Proto: https` correctly.
- **One FFmpeg per listener doesn't scale**: each FFmpeg is ~60 MB RSS, so
  per-listener processes capped the 512 MB box at a handful of Cast devices.
  `broadcaster.ts` runs one per station and fans the ADTS stream out.

---

## Commands

```bash
# Cast a station immediately
npm run cast-now "Golden Temple"
npm run cast-now "Golden Temple" -- --volume=30
npm run cast-now "San Jose Gurdwara" -- --volume=25

# Stop whatever is playing
npm run stop-cast

# Adjust volume without changing station
npm run volume 40

# Run the cron scheduler (keeps process alive; triggers at configured times)
npm start

# Scan for Cast devices on the network (requires mDNS — may not work with AP isolation)
npm run discover

# Install / remove the always-on launchd agent (macOS)
npm run install-agent
npm run uninstall-agent
```
