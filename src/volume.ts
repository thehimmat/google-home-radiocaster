/**
 * Set the volume on the Cast device without changing what's playing.
 *
 * Usage:
 *   npm run volume 50
 */
import { Client } from 'castv2-client';
import { schedule } from './config';

const levelArg = process.argv[2];
const level = parseInt(levelArg, 10);

if (!levelArg || isNaN(level) || level < 0 || level > 100) {
  console.error('Usage: npm run volume <0-100>');
  process.exit(1);
}

const entry = schedule[0];
if (!entry?.deviceIp && !entry?.deviceName) {
  console.error('No device configured in schedule.');
  process.exit(1);
}

const host = entry.deviceIp ?? entry.deviceName;
const normalized = level / 100;

console.log(`Setting volume to ${level} on ${host}...`);

const client = new Client();

client.on('error', (err: Error) => {
  console.error(`Error: ${err.message}`);
  client.close();
  process.exit(1);
});

client.connect(host, () => {
  client.setVolume({ level: normalized }, (err) => {
    if (err) {
      console.error(`Failed: ${err.message}`);
    } else {
      console.log('Done.');
    }
    client.close();
    process.exit(0);
  });
});
