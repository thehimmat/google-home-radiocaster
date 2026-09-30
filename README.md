# Radio Caster

Play public radio stations on a Google Home or Nest Hub on a cron schedule, using the Cast protocol.

---

## Prerequisites

- **Node.js 18+** — check with `node --version`
- Your computer and Google Home device must be on the **same WiFi network**

---

## Install

```bash
npm install
```

---

## Setup

Configuration lives in two files:

- `src/config.ts` — tracked in git. Stations and their display metadata.
- `src/config.local.ts` — **gitignored**, per machine. Your device's name and IP, and when to fire.

**1. Add your stations** — fill in the `stations` map in `src/config.ts` with friendly names and direct stream URLs:

```ts
const defaultStations: Record<string, StationConfig> = {
  "OPB News": { url: "https://opb-news.streamguys1.com/opb-news-mp3" },
  "KEXP":     { url: "https://kexp-mp3-128.streamguys1.com/kexp128.mp3" },
};
```

> To find a stream URL: search `[Station name] direct stream MP3 URL`, or check the station's website. You need a URL that ends in `.mp3` or `.aac` — not a playlist (`.m3u`, `.pls`).

**2. Set your schedule** — create your local config from the example and edit it:

```bash
cp src/config.local.example.ts src/config.local.ts
```

```ts
export const schedule: LocalConfig['schedule'] = [
  {
    cron: "0 7 * * 1-5",       // 7:00am Monday–Friday
    station: "OPB News",
    deviceName: "Living Room display",  // as shown in the Google Home app
    deviceIp: "192.168.1.42",           // from your router's device list
    volume: 60,
  },
];
```

> To find your device name: open the Google Home app, tap the device, and copy the name shown at the top.

A `schedule` in `config.local.ts` replaces the one in `config.ts`. A `stations` export there is merged in by key, so you can override a URL or add a station for one machine only. Without a `config.local.ts` the placeholder schedule in `config.ts` is used.

> **Upgrading a machine that edited `config.ts` directly** (with `git update-index --skip-worktree`): run `git update-index --no-skip-worktree src/config.ts`, move your schedule entry into a new `src/config.local.ts`, then `git checkout src/config.ts` and pull.

---

## Test it works

Before waiting for the cron schedule, cast a station right now:

```bash
npm run cast-now "OPB News"
```

You can also specify the device name as a second argument:

```bash
npm run cast-now "KEXP" "Bedroom speaker"
```

---

## Run the scheduler

```bash
npm start
```

This starts the process and keeps it running. Cron jobs fire at the times you set in `config.local.ts`. Press `Ctrl+C` to stop.

---

## Keep it running on Mac

The simplest option is to leave the terminal window open with `npm start` running.

For an always-on setup, install it as a `launchd` user agent. It starts at login, restarts if it ever exits, and survives reboots:

```bash
npm run install-agent
```

This renders `deploy/com.atthebunga.radiocaster.plist.example` with this checkout's path and your `node` binary, writes it to `~/Library/LaunchAgents/`, and loads it. Re-run it after moving the repo or upgrading Node. To remove it:

```bash
npm run uninstall-agent
```

Useful afterwards:

```bash
tail -f ~/Library/Logs/radiocaster/radiocaster.log        # what the agent is doing
launchctl print gui/$(id -u)/com.atthebunga.radiocaster    # is it loaded / running
```

The log rotates itself once it passes 5 MB (three old copies are kept). On a dedicated machine, also stop it sleeping: `sudo pmset -c sleep 0 disksleep 0`, and check the time zone matches your cron times.

If `npm run install-agent` says it can't find `node`, set `RADIOCASTER_NODE=/path/to/node` when running it.

---

## Troubleshooting

**Device not found (mDNS flakiness)**

mDNS discovery occasionally fails, especially if your router is strict about multicast traffic. If you see a "not found" error:

1. Make sure the device name in `config.local.ts` exactly matches the name in the Google Home app.
2. Try connecting by IP instead — find the device's IP address in your router's device list or in the Google Home app under device settings, then add `deviceIp: "192.168.x.x"` to the schedule entry:

```ts
{
  cron: "0 7 * * 1-5",
  station: "OPB News",
  deviceName: "Living Room display",
  deviceIp: "192.168.1.42",   // <-- add this
  volume: 60,
},
```

**Stream doesn't play**

- Make sure the URL is a direct audio stream, not a playlist file.
- Try opening the URL in a browser or VLC to confirm it works.
- Some streams use AAC (`.aac`). If a station won't play, try finding its MP3 stream instead.

**`npm install` errors on macOS**

If you see errors about native binaries, run:

```bash
xcode-select --install
```

Then retry `npm install`. The `bonjour-service` package used for device discovery is pure JavaScript and shouldn't need this, but some transitive dependencies might.
