import express from 'express';
import * as https from 'https';
import * as http from 'http';
import { IncomingMessage, ServerResponse } from 'http';

const app = express();
const PORT = process.env.PORT ?? 3001;

const lenientHttpsAgent = new https.Agent({ rejectUnauthorized: false });

const STATIONS: Record<string, { url: string; contentType: string }> = {
  'golden-temple': {
    url: 'https://live.sgpc.net:8443/',
    // Upstream serves audio/aacp but Cast devices only accept audio/aac —
    // they're the same codec (HE-AAC), the receiver just needs the right label.
    contentType: 'audio/aac',
  },
};

const UPSTREAM_HEADERS = {
  // A browser UA causes Shoutcast to return an HTML redirect page instead
  // of the audio stream. A media player UA gets the raw bytes.
  'User-Agent': 'WinampMPEG/5.0',
  'Icy-MetaData': '0',
};

/**
 * Opens a connection to the upstream Shoutcast server and pipes audio into
 * res. If the upstream drops (network blip, server restart, etc.), waits
 * briefly and reconnects — keeping the downstream connection to the Cast
 * device alive so playback resumes without the device stopping.
 */
function pipeWithReconnect(
  stationUrl: string,
  res: ServerResponse,
  retryDelay = 1000,
): void {
  // Stop trying once the Cast device has disconnected.
  if (res.destroyed) return;

  const lib = stationUrl.startsWith('https') ? https : http;

  const upstream = lib.get(
    stationUrl,
    {
      agent: stationUrl.startsWith('https') ? lenientHttpsAgent : undefined,
      headers: UPSTREAM_HEADERS,
    },
    (upRes: IncomingMessage) => {
      // Reset retry delay on successful connection.
      retryDelay = 1000;

      // pipe without closing res when upstream ends — we'll reconnect instead.
      upRes.pipe(res, { end: false });

      upRes.on('end', () => {
        console.log(`Upstream ended, reconnecting in ${retryDelay}ms...`);
        setTimeout(() => pipeWithReconnect(stationUrl, res, retryDelay), retryDelay);
      });

      // If the Cast device disconnects, stop pulling from upstream.
      res.on('close', () => upstream.destroy());
    },
  );

  upstream.on('error', (err) => {
    // Cap retry delay at 10s.
    const nextDelay = Math.min(retryDelay * 2, 10000);
    console.error(`Upstream error: ${err.message} — retrying in ${retryDelay}ms`);
    setTimeout(() => pipeWithReconnect(stationUrl, res, nextDelay), retryDelay);
  });
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', stations: Object.keys(STATIONS) });
});

app.head('/:station', (req, res) => {
  const station = STATIONS[req.params.station];
  if (!station) { res.sendStatus(404); return; }
  res.set('Content-Type', station.contentType).sendStatus(200);
});

app.get('/:station', (req, res) => {
  const station = STATIONS[req.params.station];
  if (!station) {
    res.status(404).json({
      error: `Unknown station. Available: ${Object.keys(STATIONS).join(', ')}`,
    });
    return;
  }

  const client = req.socket.remoteAddress ?? 'unknown';
  console.log(`[${req.params.station}] client connected: ${client}`);

  res.writeHead(200, {
    'Content-Type': station.contentType,
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache, no-store',
    'Transfer-Encoding': 'chunked',
    'Access-Control-Allow-Origin': '*',
  });

  res.on('close', () => {
    console.log(`[${req.params.station}] client disconnected: ${client}`);
  });

  pipeWithReconnect(station.url, res);
});

app.listen(PORT, () => {
  console.log(`Streaming server on port ${PORT}`);
  console.log(`Stations: ${Object.keys(STATIONS).map((s) => `/${s}`).join(', ')}`);
});
