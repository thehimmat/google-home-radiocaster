import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

const app = express();
// Trust Railway's X-Forwarded-Proto header so req.protocol returns 'https',
// which is required for correct absolute URLs in the rewritten M3U8 playlist.
app.set('trust proxy', true);

const PORT = process.env.PORT ?? 3001;
const HLS_ROOT = '/tmp/hls';
const HLS_LIST_SIZE = 15;

const STATIONS: Record<string, { url: string }> = {
  'golden-temple': {
    url: 'https://live.sgpc.net:8443/',
  },
  'san-jose': {
    url: 'https://radio.sikhnet.com/proxy/channel18/live',
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

/**
 * Read the current EXT-X-MEDIA-SEQUENCE from an existing playlist so that
 * when FFmpeg restarts we can pass -start_number and avoid jumping backwards.
 * Jumping backwards confuses HLS clients into stopping playback.
 */
function getNextStartNumber(station: string): number {
  try {
    const content = fs.readFileSync(playlistPath(station), 'utf8');
    const match = content.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    if (match) {
      // Skip past the current window plus a small buffer so there's no
      // overlap or backwards jump.
      return parseInt(match[1]) + HLS_LIST_SIZE + 5;
    }
  } catch {
    // No existing playlist — starting fresh.
  }
  return 0;
}

function startFfmpeg(station: string, upstreamUrl: string): void {
  const dir = hlsDir(station);
  fs.mkdirSync(dir, { recursive: true });

  const startNumber = getNextStartNumber(station);

  const args = [
    // Reconnect automatically on upstream drop/EOF.
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '30',
    // Shoutcast returns an HTML page for browser UAs; this gets raw audio.
    '-user_agent', 'WinampMPEG/5.0',
    // SGPC uses a self-signed cert on port 8443.
    '-tls_verify', '0',
    '-i', upstreamUrl,
    // Re-encode to AAC — required for Cast Default Media Receiver.
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    // HLS output. Segment filename and playlist are BARE (no path) so FFmpeg
    // writes bare names into the M3U8 — we rewrite them to full URLs in Express.
    // Using cwd:dir means all files land in the right place.
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', String(HLS_LIST_SIZE),
    '-hls_flags', 'delete_segments+omit_endlist',
    '-start_number', String(startNumber),
    '-hls_segment_filename', 'seg%05d.ts',
    'stream.m3u8',
  ];

  // cwd:dir is critical — bare filenames in args are resolved relative to this
  // directory, so segments and playlist end up in /tmp/hls/{station}/ and the
  // M3U8 references them as plain "seg00000.ts" (not absolute filesystem paths).
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: dir });
  ffmpegProcesses.set(station, proc);

  proc.stderr?.on('data', (chunk: Buffer) => {
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

  console.log(`[ffmpeg:${station}] started (pid=${proc.pid}, start_number=${startNumber})`);
}

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
  // Use .end() not .sendStatus() — sendStatus sends a body which triggers
  // Express to override the Content-Type we just set.
  res.set('Content-Type', 'application/x-mpegURL').status(200).end();
});

// Serve the M3U8 playlist. FFmpeg writes bare segment filenames into the
// playlist (e.g. "seg00000.ts"). We rewrite them to absolute HTTPS URLs so
// the Cast device knows where to fetch each segment.
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

  const raw = fs.readFileSync(playlistPath(station), 'utf8');
  // Rewrite bare "seg00000.ts" lines to full URLs. The m flag makes ^ and $
  // match line boundaries; \r? handles any stray Windows line endings.
  const baseUrl = `${req.protocol}://${req.get('host')}/${station}/`;
  const rewritten = raw.replace(/^(seg\d+\.ts)\r?$/gm, `${baseUrl}$1`);

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
