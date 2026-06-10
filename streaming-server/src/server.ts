import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { createApp, StationMap, HLS_LIST_SIZE, hlsDir, playlistPath } from './app';
import { StationBroadcaster } from './broadcaster';
import { buildHlsArgs } from './ffmpeg-args';

const PORT = process.env.PORT ?? 3001;
// Use /data/hls when mounted on a persistent Fly.io volume; fall back to /tmp for local dev.
const HLS_ROOT = process.env.HLS_ROOT ?? '/tmp/hls';

const STATIONS: StationMap = {
  'golden-temple': {
    url: 'https://live.sgpc.net:8443/',
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
        if (proc) {
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
// HTTP server
// ---------------------------------------------------------------------------

const app = createApp(STATIONS, HLS_ROOT, ffmpegProcesses, spawn, broadcasters);

app.listen(PORT, () => {
  console.log(`Streaming server on port ${PORT}`);
  console.log(`Stations: ${Object.keys(STATIONS).map((s) => `/${s}`).join(', ')}`);
});
