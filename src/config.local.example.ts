// =============================================================================
// LOCAL CONFIG — copy this file to `src/config.local.ts` and edit it.
//
// `config.local.ts` is gitignored. Put anything machine- or network-specific
// here (your device's IP, its name, the time you want it to fire) so the
// tracked `config.ts` never carries your real values.
//
//   cp src/config.local.example.ts src/config.local.ts
//
// Both exports are optional:
//   - `schedule` replaces the tracked schedule entirely.
//   - `stations` is merged into the tracked stations by key (override a URL,
//     or add a station only this machine should know about).
// =============================================================================
import type { LocalConfig } from './local-config';

export const schedule: LocalConfig['schedule'] = [
  {
    cron: "0 6 * * *",              // 6:00 am, every day
    station: "Golden Temple",       // key from the `stations` map in config.ts
    deviceName: "Living Room display",
    deviceIp: "192.168.1.42",       // find it in your router's device list
    volume: 30,
  },
];

// export const stations: LocalConfig['stations'] = {
//   "My Local Station": { url: "http://192.168.1.10:8000/stream" },
// };
