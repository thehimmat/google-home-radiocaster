/**
 * Scans the local network for all Google Cast devices and prints their
 * advertised names and IP addresses. Run this to find the exact device name
 * to use in config.ts, or to grab the IP for a static deviceIp entry.
 *
 * Usage: npm run discover
 */
import { Bonjour, Service } from 'bonjour-service';

const SCAN_DURATION_MS = 10000;

console.log(`Scanning for Cast devices for ${SCAN_DURATION_MS / 1000}s...\n`);

const bonjour = new Bonjour();
const found: Service[] = [];

const browser = bonjour.find({ type: 'googlecast' });

browser.on('up', (service: Service) => {
  found.push(service);
  const txt = service.txt as Record<string, string> | undefined;
  const friendlyName = txt?.fn ?? service.name;
  const ipv4 = service.addresses?.find((a: string) => !a.includes(':')) ?? service.host;
  console.log(`  Found: "${friendlyName}"  →  ${ipv4}:${service.port}`);
});

setTimeout(() => {
  browser.stop();
  bonjour.destroy();

  if (found.length === 0) {
    console.log('No Cast devices found.');
    console.log('\nPossible reasons:');
    console.log('  • Your Mac and the device are on different network segments');
    console.log('  • Your router has "client isolation" or "AP isolation" enabled');
    console.log('  • The device is on a guest network');
    console.log('\nFix: find the device IP in your router admin page or Google Home app,');
    console.log('then add  deviceIp: "192.168.x.x"  to the schedule entry in config.ts.');
  } else {
    console.log(`\nFound ${found.length} device(s).`);
    console.log('Copy the name exactly into config.ts, or use deviceIp to bypass discovery.');
  }

  process.exit(0);
}, SCAN_DURATION_MS);
