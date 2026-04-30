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
    contentType: 'audio/aacp',
  },
};

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', stations: Object.keys(STATIONS) });
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
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Icy-MetaData': '0',
      },
    },
    (upRes) => {
      const upType = upRes.headers['content-type']?.split(';')[0].trim();
      const isAudio = upType && (upType.startsWith('audio/') || upType === 'application/ogg');

      res.writeHead(200, {
        'Content-Type': isAudio ? upType : station.contentType,
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
