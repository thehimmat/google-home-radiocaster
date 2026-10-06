import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { createApp, evaluateStations, readMediaSequence, StationMap, HLS_LIST_SIZE, hlsDir, playlistPath } from './app';
import { archiverEnvFromProcess, createR2Uploader, StationArchiver } from './archiver';
import { StationBroadcaster } from './broadcaster';
import { buildHlsArgs, HLS_SEGMENT_SECONDS } from './ffmpeg-args';
import { UpstreamMonitor } from './upstream-monitor';
import { StatusHistory } from './status-history';
import { StatusTracker } from './status-tracker';
import { QualityPoller } from './quality-poller';
import { RestartPolicy } from './restart-policy';
import { sampleSource } from './stream-quality';

const PORT = process.env.PORT ?? 3001;
// Use /data/hls when mounted on a persistent Fly.io volume; fall back to /tmp for local dev.
const HLS_ROOT = process.env.HLS_ROOT ?? '/tmp/hls';

const STATIONS: StationMap = {
  'golden-temple': {
    // Port 8442 is what sgpc.net's own web player uses (2026-10-06); 8443
    // kept resetting our long-lived connection and ran at ~0.7x real time.
    url: 'https://live.sgpc.net:8442/',
    title: 'Golden Temple Radio',
    subtitle: 'Amritsar',
    artworkUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e5/Amritsar_golden_temple_night_view.JPG/1280px-Amritsar_golden_temple_night_view.JPG',
  },
  'san-jose': {
    url: 'https://radio.sikhnet.com/proxy/channel18/live',
    title: 'Gurdwara San Jose',
    subtitle: 'San Jose, CA',
  },
};

// ---------------------------------------------------------------------------
// FFmpeg process management
// ---------------------------------------------------------------------------

const ffmpegProcesses = new Map<string, ChildProcess>();
// Per-station respawn backoff — see RestartPolicy.
const restartPolicies = new Map<string, RestartPolicy>();
function restartPolicy(station: string): RestartPolicy {
  let policy = restartPolicies.get(station);
  if (!policy) {
    policy = new RestartPolicy();
    restartPolicies.set(station, policy);
  }
  return policy;
}
// /stream broadcasters — created lazily by the app on first listener.
const broadcasters = new Map<string, StationBroadcaster>();

process.on('SIGTERM', () => {
  console.log('SIGTERM received — killing FFmpeg processes...');
  for (const [name, proc] of ffmpegProcesses) {
    proc.kill();
    console.log(`  killed [ffmpeg:${name}]`);
  }
  for (const [name, broadcaster] of broadcasters) {
    broadcaster.stop();
    console.log(`  stopped [stream:${name}]`);
  }
  process.exit(0);
});

/**
 * Read the current EXT-X-MEDIA-SEQUENCE from an existing playlist so that
 * when FFmpeg restarts we can pass -start_number and avoid jumping backwards.
 * Jumping backwards confuses HLS clients into stopping playback.
 */
function getNextStartNumber(station: string): number {
  try {
    const content = fs.readFileSync(playlistPath(HLS_ROOT, station), 'utf8');
    const match = content.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    if (match) {
      return parseInt(match[1]) + HLS_LIST_SIZE + 5;
    }
  } catch {
    // No existing playlist — starting fresh.
  }
  return 0;
}

function startFfmpeg(station: string, upstreamUrl: string): void {
  const dir = hlsDir(HLS_ROOT, station);
  fs.mkdirSync(dir, { recursive: true });

  const startNumber = getNextStartNumber(station);

  const args = buildHlsArgs(upstreamUrl, { listSize: HLS_LIST_SIZE, startNumber });

  // cwd:dir is critical — bare filenames in args are resolved relative to this
  // directory, so segments and playlist end up in /tmp/hls/{station}/ and the
  // M3U8 references them as plain "seg00000.ts" (not absolute filesystem paths).
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: dir });
  ffmpegProcesses.set(station, proc);
  restartPolicy(station).started();

  proc.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString();
    if (line.includes('Error') || line.includes('error') || line.includes('warn')) {
      process.stderr.write(`[ffmpeg:${station}] ${line}`);
    }
  });

  proc.on('exit', (code, signal) => {
    const delay = restartPolicy(station).exited();
    console.log(`[ffmpeg:${station}] exited (code=${code} signal=${signal}), restarting in ${delay / 1000}s...`);
    ffmpegProcesses.delete(station);
    setTimeout(() => startFfmpeg(station, upstreamUrl), delay);
  });

  console.log(`[ffmpeg:${station}] started (pid=${proc.pid}, start_number=${startNumber})`);
}

// ---------------------------------------------------------------------------
// Watchdog — restarts FFmpeg if the playlist goes stale
// ---------------------------------------------------------------------------

// If no new HLS segment has been written in this window, the FFmpeg process is
// stuck (e.g. internal reconnect loop after upstream drop). Killing it lets
// the proc.on('exit') handler restart it cleanly.
const WATCHDOG_INTERVAL_MS = 20_000;
const WATCHDOG_STALE_MS = 30_000;

function startWatchdog(station: string): void {
  setInterval(() => {
    try {
      const age = Date.now() - fs.statSync(playlistPath(HLS_ROOT, station)).mtimeMs;
      if (age > WATCHDOG_STALE_MS) {
        const proc = ffmpegProcesses.get(station);
        // A freshly (re)started FFmpeg hasn't had time to write a segment yet;
        // killing it here just feeds the restart loop.
        if (proc && restartPolicy(station).runningFor() >= WATCHDOG_STALE_MS) {
          console.log(`[watchdog:${station}] playlist stale (${Math.round(age / 1000)}s) — restarting FFmpeg`);
          proc.kill('SIGKILL');
        }
      }
    } catch {
      // Playlist not yet created — FFmpeg still initializing, nothing to do.
    }
  }, WATCHDOG_INTERVAL_MS);
}

for (const [name, station] of Object.entries(STATIONS)) {
  startFfmpeg(name, station.url);
  startWatchdog(name);
}

// ---------------------------------------------------------------------------
// R2 segment archiver (opt-in via R2_* env vars) — feeds the future
// time-shift feature; a 24h R2 lifecycle rule handles cleanup
// ---------------------------------------------------------------------------

const archiverEnv = archiverEnvFromProcess();
if (archiverEnv) {
  const uploader = createR2Uploader(archiverEnv);
  for (const name of Object.keys(STATIONS)) {
    new StationArchiver(name, hlsDir(HLS_ROOT, name), uploader).start();
  }
  console.log(`[archiver] enabled — uploading segments to bucket "${archiverEnv.bucket}"`);
} else {
  console.log('[archiver] R2 env vars not set — segment archiving disabled');
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

// Attributes stale-playlist outages to the source vs. our pipeline for /health.
const upstreamMonitor = new UpstreamMonitor(STATIONS);

// ---------------------------------------------------------------------------
// Status history — evaluates every station on a timer and logs transitions to
// the volume, so past outages can be reconstructed via /history.
// ---------------------------------------------------------------------------

const STATUS_INTERVAL_MS = 20_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Lives on the persistent volume next to the HLS dirs so it survives restarts.
const statusHistory = new StatusHistory(
  process.env.STATUS_HISTORY_FILE ?? path.join(HLS_ROOT, '_status-history.jsonl'),
);
statusHistory.prune();
setInterval(() => statusHistory.prune(), PRUNE_INTERVAL_MS);
new StatusTracker(
  () => evaluateStations(STATIONS, HLS_ROOT, ffmpegProcesses, upstreamMonitor),
  statusHistory,
).start(STATUS_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Source quality poller — every QUALITY_INTERVAL_MS each station's source is
// sampled for QUALITY_SAMPLE_MS (decode only, one station at a time) and
// classified down/silent/choppy/healthy, so "it's cutting out" can be pinned
// on the broadcaster or on us. Shown on /health, changes logged to /history.
// ---------------------------------------------------------------------------

const QUALITY_INTERVAL_MS = 5 * 60_000;
// Shoutcast servers (notably SGPC) burst tens of seconds of buffered audio on
// connect, so skip the first 15s and measure the remaining 25s.
const QUALITY_SAMPLE_MS = 40_000;
const QUALITY_WARMUP_MS = 15_000;
const qualityPoller = new QualityPoller({
  stations: STATIONS,
  sample: (url) => sampleSource(url, { spawnFn: spawn, sampleMs: QUALITY_SAMPLE_MS, warmupMs: QUALITY_WARMUP_MS }),
  readSequence: (station) => readMediaSequence(HLS_ROOT, station),
  recorder: statusHistory,
  segmentSeconds: HLS_SEGMENT_SECONDS,
});
qualityPoller.start(QUALITY_INTERVAL_MS);

const app = createApp(
  STATIONS, HLS_ROOT, ffmpegProcesses, spawn, broadcasters, upstreamMonitor, statusHistory, qualityPoller,
);

app.listen(PORT, () => {
  console.log(`Streaming server on port ${PORT}`);
  console.log(`Stations: ${Object.keys(STATIONS).map((s) => `/${s}`).join(', ')}`);
});
