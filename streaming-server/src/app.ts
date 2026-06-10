import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

export type StationMap = Record<string, { url: string }>;

const HLS_LIST_SIZE = 15;

function hlsDir(hlsRoot: string, station: string): string {
  return path.join(hlsRoot, station);
}

function playlistPath(hlsRoot: string, station: string): string {
  return path.join(hlsDir(hlsRoot, station), 'stream.m3u8');
}

function waitForPlaylist(hlsRoot: string, station: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const playlist = playlistPath(hlsRoot, station);
    const deadline = Date.now() + timeoutMs;

    const check = () => {
      if (fs.existsSync(playlist)) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`Playlist not ready after ${timeoutMs}ms`));
      setTimeout(check, 250);
    };
    check();
  });
}

export function createApp(
  stations: StationMap,
  hlsRoot: string,
  // Optional reference to live FFmpeg processes — used by /health to report liveness.
  ffmpegProcesses?: Map<string, ChildProcess>,
): express.Express {
  const app = express();
  app.set('trust proxy', true);

  app.get('/health', (_req, res) => {
    const stationHealth = Object.keys(stations).map((name) => {
      const processAlive = ffmpegProcesses ? ffmpegProcesses.has(name) : null;

      // Check that the playlist exists and was written within the last 30 seconds.
      let segmentFresh: boolean | null = null;
      try {
        const stat = fs.statSync(playlistPath(hlsRoot, name));
        segmentFresh = (Date.now() - stat.mtimeMs) < 30_000;
      } catch {
        segmentFresh = false;
      }

      return { name, processAlive, segmentFresh };
    });

    const allHealthy = stationHealth.every((s) => s.segmentFresh !== false);
    res
      .status(allHealthy ? 200 : 503)
      .json({ status: allHealthy ? 'ok' : 'degraded', stations: stationHealth });
  });

  app.head('/:station', (req, res) => {
    if (!stations[req.params.station]) { res.sendStatus(404); return; }
    res.set('Content-Type', 'application/x-mpegURL').status(200).end();
  });

  app.get('/:station', async (req, res) => {
    const { station } = req.params;
    if (!stations[station]) {
      res.status(404).json({ error: `Unknown station. Available: ${Object.keys(stations).join(', ')}` });
      return;
    }

    try {
      await waitForPlaylist(hlsRoot, station);
    } catch {
      res.status(503).json({ error: 'Stream not ready yet, try again shortly.' });
      return;
    }

    let raw: string;
    try {
      raw = await fs.promises.readFile(playlistPath(hlsRoot, station), 'utf8');
    } catch {
      res.status(503).json({ error: 'Playlist unavailable.' });
      return;
    }

    const baseUrl = `${req.protocol}://${req.get('host')}/${station}/`;
    const rewritten = raw.replace(/^(seg\d+\.ts)\r?$/gm, `${baseUrl}$1`);

    res
      .set('Content-Type', 'application/x-mpegURL')
      .set('Cache-Control', 'no-cache, no-store')
      .set('Access-Control-Allow-Origin', '*')
      .send(rewritten);
  });

  // Raw audio stream endpoint — used for Cast devices.
  // Pipes FFmpeg AAC output directly to the HTTP response, avoiding HLS entirely.
  // Cast devices receive a plain audio/aac stream (same model as SomaFM MP3), which is
  // more reliable than HLS on Google Nest Hub devices.
  // This endpoint stays open for the duration of playback; Fly.io has no connection
  // timeout for active streams so this works fine (unlike Railway's 5-min kill).
  app.get('/:station/stream', (req, res) => {
    const { station } = req.params;
    if (!stations[station]) { res.sendStatus(404); return; }

    const upstreamUrl = stations[station].url;

    const args = [
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '30',
      '-user_agent', 'WinampMPEG/5.0',
      '-tls_verify', '0',
      '-i', upstreamUrl,
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      '-f', 'adts',   // ADTS-framed AAC byte stream — correct format for audio/aac
      'pipe:1',
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    console.log(`[stream:${station}] cast client connected (pid=${proc.pid})`);

    res
      .set('Content-Type', 'audio/aac')
      .set('Cache-Control', 'no-cache, no-store')
      .set('Access-Control-Allow-Origin', '*');

    proc.stdout?.pipe(res);

    const cleanup = () => {
      proc.kill('SIGKILL');
      console.log(`[stream:${station}] cast client disconnected (pid=${proc.pid})`);
    };
    req.on('close', cleanup);
    proc.on('exit', () => { if (!res.writableEnded) res.end(); });
  });

  app.get('/:station/:file', (req, res) => {
    const { station, file } = req.params;
    if (!stations[station] || !file.endsWith('.ts')) { res.sendStatus(404); return; }

    const filePath = path.join(hlsDir(hlsRoot, station), file);
    if (!fs.existsSync(filePath)) { res.sendStatus(404); return; }

    res
      .set('Content-Type', 'video/MP2T')
      .set('Cache-Control', 'public, max-age=60')
      .set('Access-Control-Allow-Origin', '*')
      .sendFile(filePath);
  });

  return app;
}

export { HLS_LIST_SIZE, hlsDir, playlistPath };
