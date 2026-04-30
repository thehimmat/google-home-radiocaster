import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

const app = express();
const PORT = process.env.PORT ?? 3001;
const HLS_ROOT = '/tmp/hls';

const STATIONS: Record<string, { url: string }> = {
  'golden-temple': {
    url: 'https://live.sgpc.net:8443/',
  },
};

// ---------------------------------------------------------------------------
// FFmpeg process management
// ---------------------------------------------------------------------------

const ffmpegProcesses: Map<string, ChildProcess> = new Map();

function hlsDir(station: string): string {
  return path.join(HLS_ROOT, station);
}

function playlistPath(station: string): string {
  return path.join(hlsDir(station), 'stream.m3u8');
}

function startFfmpeg(station: string, upstreamUrl: string): void {
  const dir = hlsDir(station);
  fs.mkdirSync(dir, { recursive: true });

  const args = [
    // Input options: reconnect on drop/EOF, spoof User-Agent so Shoutcast
    // returns raw audio instead of an HTML redirect page.
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '30',
    '-user_agent', 'WinampMPEG/5.0',
    // Accept self-signed certs (SGPC uses one on port 8443).
    '-tls_verify', '0',
    '-i', upstreamUrl,
    // Re-encode to AAC so every Cast device can play it.
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    // HLS output: 4-second segments, keep 10 in playlist, delete old ones.
    // omit_endlist keeps the playlist open-ended (live stream).
    // Base URL tells the playlist where segments live relative to the server.
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '10',
    '-hls_flags', 'delete_segments+omit_endlist',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'stream.m3u8'),
  ];

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ffmpegProcesses.set(station, proc);

  proc.stderr?.on('data', (chunk: Buffer) => {
    // FFmpeg writes progress to stderr; only log errors/warnings to avoid noise.
    const line = chunk.toString();
    if (line.includes('Error') || line.includes('error') || line.includes('warn')) {
      process.stderr.write(`[ffmpeg:${station}] ${line}`);
    }
  });

  proc.on('exit', (code, signal) => {
    console.log(`[ffmpeg:${station}] exited (code=${code} signal=${signal}), restarting in 3s...`);
    ffmpegProcesses.delete(station);
    setTimeout(() => startFfmpeg(station, upstreamUrl), 3000);
  });

  console.log(`[ffmpeg:${station}] started (pid=${proc.pid})`);
}

// Start an FFmpeg process for every station at server boot.
for (const [name, station] of Object.entries(STATIONS)) {
  startFfmpeg(name, station.url);
}

// ---------------------------------------------------------------------------
// Wait for the HLS playlist to become available
// ---------------------------------------------------------------------------

function waitForPlaylist(station: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const playlist = playlistPath(station);
    const deadline = Date.now() + timeoutMs;

    const check = () => {
      if (fs.existsSync(playlist)) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`Playlist not ready after ${timeoutMs}ms`));
      setTimeout(check, 250);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', stations: Object.keys(STATIONS) });
});

app.head('/:station', (req, res) => {
  if (!STATIONS[req.params.station]) { res.sendStatus(404); return; }
  res.set('Content-Type', 'application/x-mpegURL').sendStatus(200);
});

// Serve the M3U8 playlist — wait up to 15s for FFmpeg to produce the first one.
app.get('/:station', async (req, res) => {
  const { station } = req.params;
  if (!STATIONS[station]) {
    res.status(404).json({ error: `Unknown station. Available: ${Object.keys(STATIONS).join(', ')}` });
    return;
  }

  try {
    await waitForPlaylist(station);
  } catch {
    res.status(503).json({ error: 'Stream not ready yet, try again shortly.' });
    return;
  }

  // Read the raw playlist and rewrite segment paths to absolute server URLs
  // so Cast devices can fetch segments regardless of how they resolved this URL.
  const raw = fs.readFileSync(playlistPath(station), 'utf8');
  const baseUrl = `${req.protocol}://${req.get('host')}/${station}/`;
  const rewritten = raw.replace(/^(seg\d+\.ts)$/gm, `${baseUrl}$1`);

  res
    .set('Content-Type', 'application/x-mpegURL')
    .set('Cache-Control', 'no-cache, no-store')
    .set('Access-Control-Allow-Origin', '*')
    .send(rewritten);
});

// Serve .ts segment files.
app.get('/:station/:file', (req, res) => {
  const { station, file } = req.params;
  if (!STATIONS[station] || !file.endsWith('.ts')) { res.sendStatus(404); return; }

  const filePath = path.join(hlsDir(station), file);
  if (!fs.existsSync(filePath)) { res.sendStatus(404); return; }

  res
    .set('Content-Type', 'video/MP2T')
    .set('Cache-Control', 'public, max-age=60')
    .set('Access-Control-Allow-Origin', '*')
    .sendFile(filePath);
});

app.listen(PORT, () => {
  console.log(`Streaming server on port ${PORT}`);
  console.log(`Stations: ${Object.keys(STATIONS).map((s) => `/${s}`).join(', ')}`);
});
