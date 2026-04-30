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
  ↓  fetches audio over HTTPS
stream.atthebunga.com (Railway)
  ↓  fetches and pipes audio
Upstream source (e.g. live.sgpc.net:8443)
```

The streaming server at `stream.atthebunga.com` is necessary because:
- Some upstream streams are on non-standard ports (8443) that the Nest Hub
  may not reach depending on router config
- Some CDNs (streamguys1.com) have TLS cert mismatches that Cast devices reject
- Shoutcast servers return HTML to browser User-Agents — the relay uses
  `WinampMPEG/5.0` to get the raw audio stream

---

## Streaming server (streaming-server/)

Deployed on Railway, source in `streaming-server/src/server.ts`.
Custom domain: `stream.atthebunga.com` (CNAME → drkss7d0.up.railway.app, DNS via Vercel).

Routes:
- `GET /health` — returns `{"status":"ok","stations":[...]}`
- `HEAD /:station` — returns content-type header immediately (no upstream connection)
- `GET /:station` — pipes upstream audio to the client

To add a station: add an entry to `STATIONS` in `server.ts`, push, Railway auto-deploys.

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
  server waits for an upstream connection before responding. The server now
  handles HEAD separately (instant response), and the client has a 6s timeout.
- **mDNS not available**: Router AP isolation blocks multicast. All devices use
  `deviceIp` in config to connect directly.
- **audio/aacp vs audio/aac**: Cast Default Media Receiver accepts `audio/aac`
  but not `audio/aacp`. The streaming server normalises to `audio/aac`.

---

## Commands

```bash
npm run cast-now "Golden Temple"              # cast immediately
npm run cast-now "Golden Temple" -- --volume=30
npm run cast-now "SomaFM Groove Salad"        # sanity-check cast
npm run stop-cast                             # stop playback
npm run volume 40                             # set volume without changing station
npm start                                     # run cron scheduler
npm run discover                              # scan for Cast devices (needs mDNS)
```
