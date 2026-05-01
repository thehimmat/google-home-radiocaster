import * as https from 'https';
import * as http from 'http';
import { Bonjour, Service } from 'bonjour-service';
import { Client, DefaultMediaReceiver } from 'castv2-client';
import { startProxy } from './proxy';

const CAST_PORT = 8009;
const DISCOVERY_TIMEOUT_MS = 12000;

// ---------------------------------------------------------------------------
// Stream URL resolution
// ---------------------------------------------------------------------------

interface StreamInfo {
  url: string;
  contentType: string;
}

/**
 * Follows HTTP redirects to find the final URL, and reads the Content-Type
 * header so we can tell the Cast receiver exactly what format to expect.
 * Falls back to 'audio/mpeg' if the server doesn't respond or HEAD is blocked.
 */
function probeStream(url: string, maxHops = 5): Promise<StreamInfo> {
  return new Promise((resolve) => {
    const fallback = { url, contentType: 'audio/mpeg' };
    if (maxHops === 0) return resolve(fallback);

    const lib = url.startsWith('https') ? https : http;
    const agentOpts = url.startsWith('https') ? { rejectUnauthorized: false } : {};
    const req = lib.request(url, { method: 'HEAD', timeout: 6000, ...agentOpts }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        resolve(probeStream(next, maxHops - 1));
      } else {
        const raw = res.headers['content-type'] ?? '';
        const detected = raw.split(';')[0].trim();
        const isAudio = detected.startsWith('audio/')
          || detected === 'application/ogg'
          || detected === 'application/x-mpegURL'
          || detected === 'application/vnd.apple.mpegurl';
        resolve({ url, contentType: isAudio ? detected : 'audio/mpeg' });
      }
    });
    req.on('timeout', () => { req.destroy(); resolve(fallback); });
    req.on('error', () => resolve(fallback));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// mDNS device discovery
// ---------------------------------------------------------------------------

/**
 * Scans the local network for a Google Cast device with the given friendly name.
 * Cast devices advertise themselves via mDNS as _googlecast._tcp services.
 * The TXT record field "fn" (friendly name) matches what the Google Home app shows.
 */
function discoverDevice(deviceName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const bonjour = new Bonjour();
    const browser = bonjour.find({ type: 'googlecast' });

    const cleanup = (result?: string, err?: Error) => {
      browser.stop();
      bonjour.destroy();
      if (err) reject(err);
      else resolve(result!);
    };

    const timeout = setTimeout(() => {
      cleanup(
        undefined,
        new Error(
          `Device "${deviceName}" not found after ${DISCOVERY_TIMEOUT_MS / 1000}s.\n` +
          `  • Make sure it's on the same WiFi network.\n` +
          `  • Try setting deviceIp in config.ts to connect directly by IP.`
        )
      );
    }, DISCOVERY_TIMEOUT_MS);

    browser.on('up', (service: Service) => {
      // The TXT record "fn" field contains the friendly name shown in the Google Home app.
      const txt = service.txt as Record<string, string> | undefined;
      const friendlyName: string = txt?.fn ?? service.name ?? '';

      if (friendlyName.toLowerCase() === deviceName.toLowerCase()) {
        clearTimeout(timeout);
        // Prefer an IPv4 address; fall back to the mDNS hostname.
        const ipv4 = service.addresses?.find((a: string) => !a.includes(':'));
        const host = ipv4 ?? service.host;
        console.log(`  Found "${deviceName}" at ${host}`);
        cleanup(host);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Casting
// ---------------------------------------------------------------------------

export interface CastOptions {
  streamUrl: string;
  deviceName: string;
  volume?: number;
  /** Optional direct IP — bypasses mDNS discovery when set. */
  deviceIp?: string;
  /**
   * When true, audio is relayed through a local HTTP proxy on this machine
   * instead of being fetched directly by the Cast device. Only needed if the
   * device can't reach the stream URL (AP isolation, CDN SSL issues, etc.).
   * Defaults to false — the device fetches the URL directly.
   */
  useProxy?: boolean;
  /** Metadata displayed on the Cast device screen. */
  metadata?: {
    title?: string;
    subtitle?: string;
    artworkUrl?: string;
  };
}

export interface CastResult {
  /** Call this to stop the local proxy and free the port when you're done. */
  stopProxy: () => void;
}

/**
 * Connects to a Cast device and starts playing a radio stream. By default
 * the device fetches the stream URL directly (useProxy: false). Returns a
 * stopProxy() handle — a no-op for direct casts, shuts down the local HTTP
 * server if proxy mode was used.
 */
export async function castRadio(options: CastOptions): Promise<CastResult> {
  const { streamUrl, deviceName, volume, deviceIp, useProxy = false, metadata } = options;

  // Step 1: resolve the device's IP address.
  let host: string;
  if (deviceIp) {
    console.log(`  Using static IP ${deviceIp} for "${deviceName}"`);
    host = deviceIp;
  } else {
    console.log(`  Discovering "${deviceName}" on the network...`);
    host = await discoverDevice(deviceName);
  }

  // Step 2: probe the external stream URL to detect content type and follow redirects.
  console.log(`  Probing stream URL...`);
  const stream = await probeStream(streamUrl);
  if (stream.url !== streamUrl) {
    console.log(`  Redirected to: ${stream.url}`);
  }
  console.log(`  Content-Type: ${stream.contentType}`);

  // Step 3 (optional): start a local HTTP proxy.
  // Only used when useProxy is true — e.g. if the device can't reach the CDN
  // due to AP isolation or SSL certificate issues.
  let castUrl = stream.url;
  let stopProxy = () => {};

  if (useProxy) {
    const proxy = await startProxy(stream.url, stream.contentType);
    console.log(`  Proxy listening at ${proxy.url}`);
    castUrl = proxy.url;
    stopProxy = proxy.close;
  } else {
    console.log(`  Sending URL directly to device (no proxy)`);
  }

  // Step 4: open a TCP connection to the Cast device and start playback.
  try {
    await new Promise<void>((resolve, reject) => {
      const client = new Client();

      client.on('error', (err: Error) => {
        client.close();
        reject(new Error(`Connection error: ${err.message}`));
      });

      client.connect(host, () => {
        console.log(`  Connected to ${host}:${CAST_PORT}`);

        // Step 5: set volume (0.0–1.0 scale internally).
        if (volume !== undefined) {
          const level = Math.max(0, Math.min(100, volume)) / 100;
          client.setVolume({ level }, (err) => {
            if (err) console.warn(`  Warning: could not set volume — ${err.message}`);
          });
        }

        // Step 6: launch the Default Media Receiver (app ID CC1AD845).
        client.launch(DefaultMediaReceiver, (err, player) => {
          if (err) {
            client.close();
            return reject(new Error(`Failed to launch receiver: ${err.message}`));
          }

          // Step 7: load the stream URL (direct or proxied) into the receiver.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const media: any = {
            contentId: castUrl,
            contentType: stream.contentType,
            ...(metadata?.title || metadata?.artworkUrl ? {
              metadata: {
                metadataType: 0,
                ...(metadata.title    && { title: metadata.title }),
                ...(metadata.subtitle && { subtitle: metadata.subtitle }),
                ...(metadata.artworkUrl && { images: [{ url: metadata.artworkUrl }] }),
              },
            } : {}),
          };

          player.load(media, { autoplay: true }, (loadErr, status) => {
            if (loadErr) {
              client.close();
              return reject(new Error(`Failed to load stream: ${loadErr.message}`));
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ext = (status as any).extendedStatus;
            const effectiveState: string = ext?.playerState ?? status.playerState;

            if (effectiveState === 'LOADING' || status.playerState !== 'IDLE') {
              console.log(`  Playback started (device state: ${effectiveState})`);
              client.close();
              resolve();
            } else {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const idleReason = (status as any).idleReason ?? 'not provided';
              client.close();
              reject(new Error(
                `Device rejected the stream (idleReason: ${idleReason}).\n` +
                `  Cast URL: ${castUrl}\n` +
                `  Content-Type: ${stream.contentType}`
              ));
            }
          });
        });
      });
    });
  } catch (err) {
    stopProxy();
    throw err;
  }

  return { stopProxy };
}
