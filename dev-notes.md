# Radio Caster — Dev Notes

## What this does

Plays internet radio stations on a Google Home / Nest Hub (Kitchen Display, 192.168.0.5)
using the Cast protocol, with cron-based scheduling. The Mac acts as an intermediary:
it fetches the audio stream and serves it locally over HTTP so the Cast device doesn't
need direct internet access to the streaming CDN.

---

## Architecture

```
Mac (local HTTP proxy, random port)
  ↑  fetches audio via HTTPS
External radio CDN (e.g. streamguys1.com, live.sgpc.net)

Mac (Cast control, port 8009)
  ↓  sends LOAD command with local proxy URL
Nest Hub (192.168.0.5)
  ↑  fetches audio from Mac's proxy
Mac (proxy serves the audio)
```

The proxy approach was necessary because the Nest Hub could not reach external
streaming CDNs directly from its network position (see "What we tried" below).

---

## What we tried (and why we moved to the proxy)

### 1. Direct URL casting (first approach)
Sent the external stream URL directly to the Cast device via `player.load()`.

**Result:** Device accepted the LOAD command and showed `extendedStatus.playerState: LOADING`
but never transitioned to PLAYING after 3+ minutes. The device was stuck fetching
the stream from the CDN and couldn't complete it.

**Root cause candidates:**
- Router AP isolation may be restricting the Nest Hub's outbound connections to
  certain CDN IPs/ports
- StreamGuys CDN (`streamguys1.com`) has a TLS certificate mismatch — the cert
  covers `*.streamguys.com` / `streamguys.com` but the host is `streamguys1.com`
  (note the `1`). The Nest Hub's browser would reject this as an SSL error.

### 2. Content type detection via HEAD request
Used a HEAD request to detect the stream's content type before sending it to the
Cast device.

**Problem:** Some streaming CDN endpoints return an HTML error page (text/html)
for HEAD requests even though GET returns audio. Fixed by only trusting detected
content types that start with `audio/`.

### 3. streamType: 'LIVE' and metadata in the media object
Initial implementation included `streamType: 'LIVE'` and a `metadata` block with
the device name.

**Problem:** Documented bug in the Default Media Receiver — including `streamType`
or `metadata.title` can cause a silent IDLE failure on some devices. Stripped both;
the receiver only needs `contentId` and `contentType`.

### 4. mDNS device discovery
Used `bonjour-service` to discover the Cast device by its Google Home app display name.

**Problem:** Router has AP isolation / multicast filtering enabled — no mDNS
packets reach the Mac. Confirmed via `npm run discover` (found zero devices).

**Fix:** Added `deviceIp` field to `ScheduleEntry` in config.ts. When set, mDNS
is bypassed and the device is connected to directly by IP.

**Device:** Kitchen Display at 192.168.0.5

### 5. TLS certificate mismatch in the proxy
Once the local proxy was fetching from `opb-news.streamguys1.com`, Node.js
rejected the TLS connection because the server's cert doesn't cover `streamguys1.com`.

**Fix:** Added a lenient `https.Agent({ rejectUnauthorized: false })` for upstream
audio fetches only. This is acceptable because the content is public radio audio,
not sensitive data.

---

## Current status

- `npm run cast-now "OPB News"` connects, starts proxy, sends LOAD to device
  → device shows `extendedStatus.playerState: LOADING`
- **Audio not yet confirmed playing** — still investigating whether the Nest Hub
  can reach the Mac's proxy URL (depends on router allowing WiFi → LAN traffic)

---

## Stations configured

| Name            | URL                                    |
|-----------------|----------------------------------------|
| OPB News        | https://opb-news.streamguys1.com/opb-news-mp3 |
| KEXP            | https://kexp-mp3-128.streamguys1.com/kexp128.mp3 |
| Golden Temple   | https://live.sgpc.net:8443/            |

---

## Potential next steps / things to try

1. **Confirm proxy reachability from device**
   Test whether the Nest Hub can reach the Mac's IP by checking if any request
   lands on the proxy server after casting starts. Add a log line in proxy.ts
   when a connection is received from a client.

2. **Check if Mac is on WiFi vs Ethernet**
   If Mac is on WiFi and the router has full AP isolation, the Nest Hub can't
   initiate a connection back to the Mac's IP. If Mac is on Ethernet, it usually
   works. Check with: `networksetup -listallhardwareports`.

3. **Try binding proxy to 0.0.0.0 instead of the detected local IP**
   Current code detects the first non-loopback IPv4. On a Mac with both WiFi and
   Ethernet active, this may pick the wrong interface.

4. **Add connection logging to proxy**
   Log when the Nest Hub connects to the proxy, confirming the routing works.

5. **SGPC Golden Temple stream (live.sgpc.net:8443)**
   Port 8443 is a non-standard HTTPS port — some routers block outbound connections
   on non-standard ports. May need to find an alternative stream URL or HTTP fallback.

6. **launchd setup for always-on scheduling**
   Once playback is confirmed working, wrap `npm start` in a launchd plist so the
   scheduler starts at login and stays running.

7. **Stop-cast closes proxy too**
   Currently `npm run stop-cast` sends a Cast STOP command to the device but the
   proxy process (if started via `cast-now`) is only stopped by Ctrl+C. Could
   signal the cast-now process to exit on stop, or use a PID file approach.

---

## Commands

```bash
npm run discover          # scan network for Cast devices (requires mDNS — may not work with AP isolation)
npm run cast-now "OPB News"        # start casting immediately, keeps process alive
npm run cast-now "Golden Temple"   # SGPC live kirtan
npm run stop-cast                  # send stop command to device
npm start                          # run cron scheduler (keeps process alive)
```
