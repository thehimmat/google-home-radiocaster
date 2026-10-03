import { ChildProcess } from 'child_process';
import { SpawnFn } from './broadcaster';
import { upstreamInputArgs } from './ffmpeg-args';

/**
 * Listens to a station's *source* for a short window and judges what a
 * listener would hear. Complements the segment-freshness check in /health,
 * which only catches total outages: a source can keep a connection open while
 * delivering audio slower than real time (heard as cutting out) or only
 * silence, and the station still looks "live".
 *
 *   down    — no audio arrived at all
 *   silent  — audio arrives, but it is (nearly) all silence
 *   choppy  — audio arrives slower than real time, or keeps dropping out
 *   healthy — real-time audio with no repeated dropouts
 *
 * Deliberately approximate: thresholds are tuned for "is it obviously broken",
 * not broadcast QA.
 */
export type SourceQuality = 'down' | 'silent' | 'choppy' | 'healthy';

/** Where a problem most likely lives: the broadcaster's source or our pipeline. */
export type Cause = 'source' | 'us' | 'none';

export interface SourceSample {
  /** Whether FFmpeg decoded any audio from the source. */
  gotAudio: boolean;
  /** Wall-clock seconds measured (after warm-up). */
  wallSeconds: number;
  /** Seconds of audio decoded during those wall seconds. */
  mediaSeconds: number;
  /** Durations (s) of each silence silencedetect reported. */
  silences: number[];
}

/** Below this fraction of real time, a listener hears gaps. */
export const MIN_REALTIME_RATIO = 0.9;
const SILENT_FRACTION = 0.9;
const DROPOUT_MIN_S = 0.3;
const DROPOUT_MAX_S = 3;
const CHOPPY_DROPOUTS = 3;
/** silencedetect threshold: quieter than this counts as silence. */
const SILENCE_DB = -50;

export function realtimeRatio(s: SourceSample): number | null {
  return s.wallSeconds > 0 ? s.mediaSeconds / s.wallSeconds : null;
}

export function classifySample(s: SourceSample): SourceQuality {
  if (!s.gotAudio || s.mediaSeconds <= 0) return 'down';

  const silent = s.silences.reduce((a, b) => a + b, 0);
  if (silent >= s.mediaSeconds * SILENT_FRACTION) return 'silent';

  const ratio = realtimeRatio(s);
  if (ratio !== null && ratio < MIN_REALTIME_RATIO) return 'choppy';

  // One pause is normal programme content; several short ones are dropouts.
  const dropouts = s.silences.filter((d) => d >= DROPOUT_MIN_S && d <= DROPOUT_MAX_S).length;
  if (dropouts >= CHOPPY_DROPOUTS) return 'choppy';

  return 'healthy';
}

/**
 * pipelineRatio is how fast our own HLS pipeline produced audio for the same
 * station (null if unknown). An unhealthy source explains whatever we output;
 * a healthy source with a slow pipeline points at us.
 */
export function attributeCause(quality: SourceQuality, pipelineRatio: number | null): Cause {
  if (quality !== 'healthy') return 'source';
  if (pipelineRatio !== null && pipelineRatio < MIN_REALTIME_RATIO) return 'us';
  return 'none';
}

/** Decode-only FFmpeg (no encode, no output file): cheap enough to run periodically. */
export function buildSampleArgs(upstreamUrl: string): string[] {
  return [
    '-hide_banner', '-nostats',
    ...upstreamInputArgs(upstreamUrl),
    '-vn',
    '-af', `silencedetect=n=${SILENCE_DB}dB:d=${DROPOUT_MIN_S}`,
    '-progress', 'pipe:1',
    '-stats_period', '1',
    '-f', 'null', '-',
  ];
}

export interface SampleOpts {
  spawnFn: SpawnFn;
  /** Wall-clock length of the sample. */
  sampleMs?: number;
  /**
   * Ignore this long after the first audio: Shoutcast-style servers burst
   * their buffer on connect, which would mask a slow source.
   */
  warmupMs?: number;
  now?: () => number;
}

/** Runs FFmpeg against the source for sampleMs and summarizes what arrived. */
export function sampleSource(upstreamUrl: string, opts: SampleOpts): Promise<SourceSample> {
  const { spawnFn, sampleMs = 20_000, warmupMs = 3_000, now = Date.now } = opts;

  return new Promise((resolve) => {
    const proc: ChildProcess = spawnFn('ffmpeg', buildSampleArgs(upstreamUrl), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let firstAudioAt: number | null = null;
    // Baseline reading taken once warm-up has passed: [wall ms, media s].
    let base: [number, number] | null = null;
    let last: [number, number] | null = null;
    let mediaNow = 0;
    const silences: number[] = [];
    let openSilenceStart: number | null = null;
    let done = false;

    const onProgress = (mediaSeconds: number) => {
      mediaNow = mediaSeconds;
      if (mediaSeconds <= 0) return;
      const t = now();
      if (firstAudioAt === null) firstAudioAt = t;
      if (base === null) {
        if (t - firstAudioAt >= warmupMs) base = [t, mediaSeconds];
        else return;
      }
      last = [t, mediaSeconds];
    };

    lines(proc.stdout, (line) => {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m) onProgress(parseInt(m[1], 10) / 1e6);
    });
    lines(proc.stderr, (line) => {
      const start = /silence_start: (-?[\d.]+)/.exec(line);
      if (start) openSilenceStart = parseFloat(start[1]);
      const end = /silence_duration: ([\d.]+)/.exec(line);
      if (end) {
        silences.push(parseFloat(end[1]));
        openSilenceStart = null;
      }
    });

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (openSilenceStart !== null && mediaNow > openSilenceStart) {
        silences.push(mediaNow - openSilenceStart);
      }
      const b = base as [number, number] | null;
      const l = last as [number, number] | null;
      resolve({
        gotAudio: firstAudioAt !== null,
        wallSeconds: b && l ? (l[0] - b[0]) / 1000 : 0,
        mediaSeconds: b && l ? l[1] - b[1] : 0,
        silences,
      });
      proc.kill('SIGKILL');
    };

    const timer = setTimeout(finish, sampleMs);
    proc.on('exit', finish);
    proc.on('error', finish);
  });
}

function lines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  let buf = '';
  stream?.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() ?? '';
    for (const p of parts) onLine(p);
  });
}
