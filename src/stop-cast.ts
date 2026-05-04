/**
 * Stops whatever is playing on a Cast device.
 *
 * Usage:
 *   npm run stop-cast                   — stops the first device in your schedule
 *   npm run stop-cast "Kitchen Display" — stops a specific device by name
 */
import { Client } from 'castv2-client';
import { schedule } from './config';
import { discoverDevice } from './cast';

async function main() {
  const deviceArg = process.argv[2];
  const entry = deviceArg
    ? schedule.find((e) => e.deviceName.toLowerCase() === deviceArg.toLowerCase())
    : schedule[0];

  if (!entry) {
    const names = [...new Set(schedule.map((e) => e.deviceName))].join(', ');
    console.error(`Device "${deviceArg}" not found in schedule. Available: ${names}`);
    process.exit(1);
  }

  let host: string;
  if (entry.deviceIp) {
    host = entry.deviceIp;
  } else {
    console.log(`  Discovering "${entry.deviceName}" on the network...`);
    host = await discoverDevice(entry.deviceName);
  }

  console.log(`\nStopping "${entry.deviceName}" (${host})...`);

  const client = new Client();

  client.on('error', (err: Error) => {
    console.error(`Error: ${err.message}`);
    client.close();
    process.exit(1);
  });

  client.connect(host, () => {
    client.getStatus((err, status) => {
      if (err) {
        console.error(`Could not get device status: ${err.message}`);
        client.close();
        process.exit(1);
      }

      const app = status.applications?.[0];
      if (!app) {
        console.log('  Nothing is playing.');
        client.close();
        process.exit(0);
      }

      console.log(`  Stopping "${app.displayName}"...`);
      client.stop(app, (stopErr) => {
        if (stopErr) {
          console.error(`  Stop failed: ${stopErr.message}`);
          client.close();
          process.exit(1);
        }
        console.log('  Stopped.');
        client.close();
        process.exit(0);
      });
    });
  });
}

main().catch((err: Error) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
