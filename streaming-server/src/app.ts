import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { StationBroadcaster, SpawnFn } from './broadcaster';
import { describeClient } from './client-info';
import { UpstreamMonitor } from './upstream-monitor';
import { StatusReader } from './status-history';
import { StationHealth, siteStatus } from './status-tracker';
import { QualityReport } from './quality-poller';

export interface StationConfig {
  /** Upstream stream URL FFmpeg pulls from. */
  url: string;
  /** Display name shown by the web player and Cast metadata. Falls back to the slug. */
  title?: string;
  subtitle?: string;
  artworkUrl?: string;
}

export type StationMap = Record<string, StationConfig>;

export type { SpawnFn } from './broadcaster';

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

/** Current EXT-X-MEDIA-SEQUENCE of a station's playlist, or null if unreadable. */
export function readMediaSequence(hlsRoot: string, station: string): number | null {
  try {
    const m = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(fs.readFileSync(playlistPath(hlsRoot, station), 'utf8'));
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

const SEGMENT_FRESH_MS = 30_000;

/**
 * Status of every station right now: fresh segments mean live; stale ones are
 * attributed to the source or to us by probing the upstream. Shared by /health
 * and the background StatusTracker.
 */
export async function evaluateStations(
  stations: StationMap,
  hlsRoot: string,
  ffmpegProcesses?: Map<string, ChildProcess>,
  upstreamMonitor?: UpstreamMonitor,
): Promise<StationHealth[]> {
  return Promise.all(
    Object.keys(stations).map(async (name): Promise<StationHealth> => {
      const processAlive = ffmpegProcesses ? ffmpegProcesses.has(name) : null;

      // Check that the playlist exists and was written recently.
      let segmentFresh: boolean;
      try {
        const stat = fs.statSync(playlistPath(hlsRoot, name));
        segmentFresh = (Date.now() - stat.mtimeMs) < SEGMENT_FRESH_MS;
      } catch {
        segmentFresh = false;
      }

      if (segmentFresh) {
        upstreamMonitor?.noteStreaming(name);
        return { name, processAlive, segmentFresh, upstreamReachable: true, status: 'live' };
      }

      // Stale. Without a monitor we can't attribute the outage, so fail loud
      // (treat as our-side error). With one, probe the source to decide.
      if (!upstreamMonitor) {
        return { name, processAlive, segmentFresh, upstreamReachable: null, status: 'error' };
      }
      const upstream = await upstreamMonitor.check(name);
      return {
        name,
        processAlive,
        segmentFresh,
        upstreamReachable: upstream.reachable,
        status: upstream.reachable ? 'error' : 'source-down',
      };
    }),
  );
}

export function createApp(
  stations: StationMap,
  hlsRoot: string,
  // Optional reference to live FFmpeg processes — used by /health to report liveness.
  ffmpegProcesses?: Map<string, ChildProcess>,
  // Injectable spawn for the /stream endpoint — tests pass a fake.
  spawnFn: SpawnFn = spawn,
  // Broadcaster registry. server.ts passes its own map so SIGTERM can stop()
  // them; tests pre-seed instances with short linger windows.
  broadcasters: Map<string, StationBroadcaster> = new Map(),
  // Probes upstream sources when a station goes stale so /health can tell "our
  // pipeline broke" from "the broadcaster's source is down". Omitted in unit
  // tests, where a stale station is treated as our-side failure (fail loud).
  upstreamMonitor?: UpstreamMonitor,
  // Status transition log served at /history; omitted → /history is 404.
  history?: StatusReader,
  // Latest source audio-quality report per station (see QualityPoller), shown
  // on /health. Informational only: it never affects status or paging.
  quality?: { latest(station: string): QualityReport | undefined },
): express.Express {
  const app = express();
  app.set('trust proxy', true);

  // Serve static files (logos, cast skin, etc.)
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Per-station status for the web player's live/"not us" labels, plus a
  // site-level status for UptimeRobot. /health returns 503 only when nothing
  // is live (see siteStatus): a single dead station — whoever's fault — is
  // labelled on the site but doesn't page.
  app.get('/health', async (_req, res) => {
    const stationHealth = await evaluateStations(stations, hlsRoot, ffmpegProcesses, upstreamMonitor);
    const status = siteStatus(stationHealth);
    res
      .status(status === 'down' ? 503 : 200)
      // The web player polls this cross-origin for the live indicators.
      .set('Access-Control-Allow-Origin', '*')
      .json({
        status,
        stations: quality
          ? stationHealth.map((s) => ({ ...s, quality: quality.latest(s.name) ?? null }))
          : stationHealth,
      });
  });

  // Status transition log (see StatusHistory), for reconstructing outages:
  //   /history?station=<slug|*>&since=<ISO time>&limit=<n>
  app.get('/history', (req, res) => {
    if (!history) { res.sendStatus(404); return; }
    const { station, since, limit } = req.query;
    const sinceMs = typeof since === 'string' ? Date.parse(since) : undefined;
    if (sinceMs !== undefined && Number.isNaN(sinceMs)) {
      res.status(400).json({ error: 'since must be an ISO 8601 time' });
      return;
    }
    const limitN = typeof limit === 'string' ? parseInt(limit, 10) : undefined;
    res.set('Access-Control-Allow-Origin', '*').json(
      history.read({
        station: typeof station === 'string' ? station : undefined,
        since: sinceMs,
        limit: limitN !== undefined && limitN > 0 ? limitN : undefined,
      }),
    );
  });

  // Station list for the web player: display metadata plus the paths clients
  // should use — hlsPath for browsers (hls.js / Safari), streamPath for Cast.
  // Registered before the /:station routes so the literal path wins.
  app.get('/stations', (_req, res) => {
    const list = Object.entries(stations).map(([slug, station]) => ({
      slug,
      title: station.title ?? slug,
      subtitle: station.subtitle ?? null,
      artworkUrl: station.artworkUrl ?? null,
      hlsPath: `/${slug}`,
      streamPath: `/${slug}/stream`,
    }));
    res.set('Access-Control-Allow-Origin', '*').json(list);
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
  // A per-station broadcaster runs ONE FFmpeg (ADTS-framed AAC) shared by all
  // connected listeners; per-listener FFmpeg processes would exhaust the box.
  // This endpoint stays open for the duration of playback; Fly.io has no
  // connection timeout for active streams (unlike Railway's 5-min kill).
  app.get('/:station/stream', (req, res) => {
    const { station } = req.params;
    if (!stations[station]) { res.sendStatus(404); return; }

    res
      .set('Content-Type', 'audio/aac')
      .set('Cache-Control', 'no-cache, no-store')
      .set('Access-Control-Allow-Origin', '*');
    // Send headers now rather than with FFmpeg's first byte — clients see the
    // 200 immediately instead of waiting out FFmpeg's spin-up.
    res.flushHeaders();

    let broadcaster = broadcasters.get(station);
    if (!broadcaster) {
      broadcaster = new StationBroadcaster(station, stations[station].url, spawnFn);
      broadcasters.set(station, broadcaster);
    }
    broadcaster.addClient(res, describeClient(req));
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
