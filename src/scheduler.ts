import cron from 'node-cron';
import { schedule, stations } from './config';
import { castRadio } from './cast';

// Holds the stopProxy handle for the currently playing stream so we can
// shut down the old proxy before starting a new one.
let currentStopProxy: (() => void) | null = null;

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
      const streamUrl = stations[entry.station];
      if (!streamUrl) {
        console.error(`\n[${new Date().toLocaleTimeString()}] Skipping "${entry.station}" — URL not found in stations map.`);
        return;
      }

      console.log(`\n[${new Date().toLocaleTimeString()}] Starting: ${label}`);

      // Stop the previous stream's proxy before starting a new one.
      if (currentStopProxy) {
        currentStopProxy();
        currentStopProxy = null;
      }

      try {
        const { stopProxy } = await castRadio({
          streamUrl,
          deviceName: entry.deviceName,
          volume: entry.volume,
          deviceIp: entry.deviceIp,
        });
        currentStopProxy = stopProxy;
        console.log(`  Done.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  Error: ${message}`);
      }
    });
  }

  console.log(`\n${schedule.length} job(s) scheduled. Waiting for next trigger...\n`);
}
