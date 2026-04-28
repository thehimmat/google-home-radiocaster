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

Open `src/config.ts` — it's the only file you need to edit.

**1. Add your stations** — fill in the `stations` map with friendly names and direct stream URLs:

```ts
export const stations: Record<string, string> = {
  "OPB News": "https://opb-news.streamguys1.com/opb-news-mp3",
  "KEXP":     "https://kexp-mp3-128.streamguys1.com/kexp128.mp3",
};
```

> To find a stream URL: search `[Station name] direct stream MP3 URL`, or check the station's website. You need a URL that ends in `.mp3` or `.aac` — not a playlist (`.m3u`, `.pls`).

**2. Set your schedule** — add entries to the `schedule` array:

```ts
export const schedule: ScheduleEntry[] = [
  {
    cron: "0 7 * * 1-5",       // 7:00am Monday–Friday
    station: "OPB News",
    deviceName: "Living Room display",  // as shown in the Google Home app
    volume: 60,
  },
];
```

> To find your device name: open the Google Home app, tap the device, and copy the name shown at the top.

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

This starts the process and keeps it running. Cron jobs fire at the times you set in `config.ts`. Press `Ctrl+C` to stop.

---

## Keep it running on Mac

The simplest option is to leave the terminal window open with `npm start` running.

For a more permanent setup, you can use `launchd` to start it automatically at login — search "launchd plist Mac" for guides. A minimal plist would run `npx ts-node /path/to/src/index.ts` and set `RunAtLoad` to `true`.

---

## Troubleshooting

**Device not found (mDNS flakiness)**

mDNS discovery occasionally fails, especially if your router is strict about multicast traffic. If you see a "not found" error:

1. Make sure the device name in `config.ts` exactly matches the name in the Google Home app.
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
