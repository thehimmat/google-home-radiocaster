/**
 * One-shot test script — cast a station right now without waiting for a cron job.
 *
 * Usage:
 *   npm run cast-now "OPB News"
 *   npm run cast-now "KEXP" "Bedroom speaker"
 *
 * Arguments:
 *   1st: station name (must match a key in config.ts stations map)
 *   2nd: device name (optional — defaults to the first device in your schedule)
 */
import { stations, schedule } from './config';
import { castRadio } from './cast';

const stationArg = process.argv[2];
const deviceArg = process.argv[3];

if (!stationArg) {
  console.error('Usage: npm run cast-now "Station Name" ["Device Name"]');
  console.error(`\nAvailable stations: ${Object.keys(stations).join(', ')}`);
  process.exit(1);
}

const streamUrl = stations[stationArg];
if (!streamUrl) {
  console.error(`Station "${stationArg}" not found in config.ts.`);
  console.error(`Available stations: ${Object.keys(stations).join(', ')}`);
  process.exit(1);
}

// Use the provided device name, or fall back to the first device in the schedule.
const deviceName = deviceArg ?? schedule[0]?.deviceName;
if (!deviceName) {
  console.error('No device name given and schedule is empty — cannot determine device.');
  process.exit(1);
}

// Also pick up a static IP from the schedule entry if one is set for this device.
const scheduleEntry = schedule.find((e) => e.deviceName === deviceName);

console.log(`\nCasting "${stationArg}" to "${deviceName}"...`);

castRadio({
  streamUrl,
  deviceName,
  volume: scheduleEntry?.volume,
  deviceIp: scheduleEntry?.deviceIp,
})
  .then(({ stopProxy }) => {
    console.log('Done — playback started. Press Ctrl+C to stop the stream.\n');
    // Keep the process alive so the local proxy keeps serving audio.
    process.on('SIGINT', () => {
      console.log('\nStopping proxy...');
      stopProxy();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      stopProxy();
      process.exit(0);
    });
  })
  .catch((err: Error) => {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
  });
