import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess } from 'child_process';

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
