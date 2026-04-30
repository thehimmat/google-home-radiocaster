import cron from 'node-cron';
import { schedule, stations } from './config';
import { castRadio } from './cast';

// Holds the stop handle for the currently active stream. For direct casts
// this is a no-op; for proxy-mode casts it shuts down the local HTTP server.
let currentStop: (() => void) | null = null;

export function startScheduler(): void {
  console.log('\nValidating schedule...');

  for (const entry of schedule) {
    if (!stations[entry.station]) {
      console.warn(
        `  WARNING: station "${entry.station}" not found in stations map — ` +
        `this job will fail when it fires. Check config.ts.`
      );
    }
  }

  console.log('\nRegistered cron jobs:');

  for (const entry of schedule) {
    const label = `[${entry.cron}] ${entry.station} → ${entry.deviceName}`;
    console.log(`  ${label}`);

    cron.schedule(entry.cron, async () => {
      const station = stations[entry.station];
      if (!station) {
        console.error(`\n[${new Date().toLocaleTimeString()}] Skipping "${entry.station}" — URL not found in stations map.`);
        return;
      }

      console.log(`\n[${new Date().toLocaleTimeString()}] Starting: ${label}`);

      if (currentStop) {
        currentStop();
        currentStop = null;
      }

      try {
        const { stopProxy } = await castRadio({
          streamUrl: station.url,
          deviceName: entry.deviceName,
          volume: entry.volume,
          deviceIp: entry.deviceIp,
          metadata: { title: station.title, subtitle: station.subtitle, artworkUrl: station.artworkUrl },
        });
        currentStop = stopProxy;
        console.log(`  Done.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  Error: ${message}`);
      }
    });
  }

  console.log(`\n${schedule.length} job(s) scheduled. Waiting for next trigger...\n`);
}
