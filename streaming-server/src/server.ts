import express from 'express';
import * as https from 'https';
import * as http from 'http';

const app = express();
const PORT = process.env.PORT ?? 3001;

// Shoutcast CDNs sometimes serve audio behind TLS certs that don't exactly
// match the hostname. Since this is public radio audio, we allow that.
const lenientHttpsAgent = new https.Agent({ rejectUnauthorized: false });

const STATIONS: Record<string, { url: string; contentType: string }> = {
  'golden-temple': {
    url: 'https://live.sgpc.net:8443/',
    // Upstream serves audio/aacp but Cast devices only accept audio/aac —
    // they're the same codec (HE-AAC), the receiver just needs the right label.
    contentType: 'audio/aac',
  },
};

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

  const lib = station.url.startsWith('https') ? https : http;

  const upstream = lib.get(
    station.url,
    {
      agent: station.url.startsWith('https') ? lenientHttpsAgent : undefined,
      headers: {
          // A browser UA causes Shoutcast to return an HTML redirect page instead
          // of the audio stream. A media player UA gets the raw bytes.
          'User-Agent': 'WinampMPEG/5.0',
          'Icy-MetaData': '0',
        },
    },
    (upRes) => {
      res.writeHead(200, {
        'Content-Type': station.contentType,
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache, no-store',
        'Transfer-Encoding': 'chunked',
        'Access-Control-Allow-Origin': '*',
      });

      upRes.pipe(res);
      res.on('close', () => upstream.destroy());
    },
  );

  upstream.on('error', (err) => {
    console.error(`[${req.params.station}] upstream error: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Stream unavailable upstream' });
    } else {
      res.destroy();
    }
  });
});

app.listen(PORT, () => {
  console.log(`Streaming server on port ${PORT}`);
  console.log(`Stations: ${Object.keys(STATIONS).map((s) => `/${s}`).join(', ')}`);
});
