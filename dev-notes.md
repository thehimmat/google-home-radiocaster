# Radio Caster — Dev Notes

## What this does

Plays internet radio on a Google Home / Nest Hub (Kitchen Display, 192.168.0.5)
using the Cast protocol, with cron-based scheduling.

---

## Architecture

```
Mac (cast-now / scheduler)
  ↓  sends LOAD with stream URL
Nest Hub (192.168.0.5, port 8009)
  ↓  fetches HLS playlist + segments over HTTPS
stream.atthebunga.com (Railway, Dockerised)
  ↓  FFmpeg transcodes and writes 4-second .ts segments to /tmp/hls/
Upstream source (e.g. live.sgpc.net:8443, radio.sikhnet.com)
```

The streaming relay at `stream.atthebunga.com` is necessary because:
- Some upstream streams are on non-standard ports (8443) that the Nest Hub
  may not reach depending on router config
- Some CDNs (streamguys1.com) have TLS cert mismatches that Cast devices reject
- Shoutcast servers return HTML to browser User-Agents — the relay uses
  `WinampMPEG/5.0` to get the raw audio stream

**HLS instead of raw streaming**: Railway terminates HTTP connections after
5 minutes on public networking. Using HLS means each request is a short
playlist fetch or a 4-second segment download — the timeout never fires.

---

## Streaming server (streaming-server/)

Deployed on Railway via Docker (Dockerfile in streaming-server/).
FFmpeg is installed in the container; one FFmpeg process runs per station at
boot, writing segments to `/tmp/hls/{station}/`.

Custom domain: `stream.atthebunga.com` (CNAME → drkss7d0.up.railway.app, DNS via Vercel).

Routes:
- `GET /health` — returns `{"status":"ok","stations":[...]}`
- `HEAD /:station` — returns `Content-Type: application/x-mpegURL` immediately
- `GET /:station` — serves the rewritten M3U8 playlist (segment URLs rewritten to absolute HTTPS)
- `GET /:station/:file.ts` — serves individual HLS segment files

To add a station:
1. Add an entry to `STATIONS` in `streaming-server/src/server.ts`
2. Add an entry to `stations` in `src/config.ts` pointing to `https://stream.atthebunga.com/<slug>`
3. Push — Railway auto-deploys

---

## Current stations

| Key in config.ts     | Relay URL                                    | Upstream                                    |
|----------------------|----------------------------------------------|---------------------------------------------|
| Golden Temple        | stream.atthebunga.com/golden-temple          | live.sgpc.net:8443 (Shoutcast, AAC+)       |
| San Jose Gurdwara    | stream.atthebunga.com/san-jose               | radio.sikhnet.com/proxy/channel18/live (MP3)|
| SomaFM Groove Salad  | ice1.somafm.com/groovesalad-128-mp3 (direct) | —                                           |

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
- **Railway 5-min timeout**: Railway's public networking kills any HTTP response
  open longer than 5 minutes. Solved by HLS — no single connection stays open.
- **HLS segment paths**: FFmpeg writes bare filenames (e.g. `seg00000.ts`) into
  the M3U8 only when spawned with `cwd` set to the output directory. Without
  `cwd`, it writes absolute filesystem paths that Cast devices can't fetch.
- **req.protocol behind Railway**: Railway terminates TLS at the edge; inside
  the container `req.protocol` is `http`. `app.set('trust proxy', true)` makes
  Express read `X-Forwarded-Proto: https` correctly.

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
```
