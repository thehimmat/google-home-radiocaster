/**
 * One-shot script — cast a station right now without waiting for a cron job.
 *
 * Usage:
 *   npm run cast-now "Golden Temple"
 *   npm run cast-now "San Jose Gurdwara" -- --volume=40
 *   npm run cast-now "Golden Temple" "Living Room display"
 *
 * Arguments:
 *   1st: station name (must match a key in config.ts stations map)
 *   2nd: device name (optional — defaults to the first device in your schedule)
 *   --volume=N: override volume 0–100 (otherwise uses schedule entry value)
 *   --proxy: relay audio through a local HTTP server on this machine (rarely needed)
 */
import { stations, schedule } from './config';
import { castRadio } from './cast';

const args = process.argv.slice(2);
const useProxy = args.includes('--proxy');
const volumeArg = args.find((a) => a.startsWith('--volume='));
const volumeOverride = volumeArg ? parseInt(volumeArg.split('=')[1], 10) : undefined;
const positional = args.filter((a) => !a.startsWith('--'));

const stationArg = positional[0];
const deviceArg = positional[1];

if (!stationArg) {
  console.error('Usage: npm run cast-now "Station Name" ["Device Name"]');
  console.error(`\nAvailable stations: ${Object.keys(stations).join(', ')}`);
  process.exit(1);
}

const stationConfig = stations[stationArg];
if (!stationConfig) {
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

console.log(`\nCasting "${stationArg}" to "${deviceName}"${useProxy ? ' via local proxy' : ' (direct)'}...`);

castRadio({
  streamUrl: stationConfig.url,
  contentType: stationConfig.contentType,
  deviceName,
  volume: volumeOverride ?? scheduleEntry?.volume,
  deviceIp: scheduleEntry?.deviceIp,
  useProxy,
  metadata: { title: stationConfig.title, subtitle: stationConfig.subtitle, artworkUrl: stationConfig.artworkUrl },
})
  .then(({ stopProxy }) => {
    if (useProxy) {
      console.log('Done — playback started via proxy. Press Ctrl+C to stop the stream.\n');
      // Keep alive so the local proxy keeps serving audio to the device.
      process.on('SIGINT', () => {
        console.log('\nStopping proxy...');
        stopProxy();
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        stopProxy();
        process.exit(0);
      });
    } else {
      console.log('Done — stream URL sent to device. The device fetches audio directly.\n');
      process.exit(0);
    }
  })
  .catch((err: Error) => {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
  });
