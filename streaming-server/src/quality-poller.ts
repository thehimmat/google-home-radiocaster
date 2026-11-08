import { LevelRecorder, StatusRecorder } from './status-history';
import {
  attributeCause,
  Cause,
  classifySample,
  meanLevelDb,
  realtimeRatio,
  SourceQuality,
  SourceSample,
} from './stream-quality';

/**
 * Periodically samples each station's source (see stream-quality) and compares
 * it with how fast our own HLS pipeline is producing audio and, with
 * listenerUrl set, with what a listener of our public /stream receives over
 * the same window, so "it's cutting out" can be pinned on the broadcaster, on
 * us, or on delivery. Results show on /health and
 * quality changes are logged to /history (kind "quality"). Never pages: per
 * the alerting policy, single-station problems are labelled, not alerted.
 */

export interface QualityReport {
  quality: SourceQuality;
  cause: Cause;
  /** Source audio seconds per wall second during the sample. */
  sourceRatio: number | null;
  /** Our HLS output audio seconds per wall second since the previous poll. */
  pipelineRatio: number | null;
  /** How our public stream sounded over the same window; null when not checked. */
  listener: SourceQuality | null;
  /** Listener audio seconds per wall second. */
  listenerRatio: number | null;
  /** Mean loudness (dB) of the source and of what a listener heard; null if unmeasured. */
  sourceDb: number | null;
  listenerDb: number | null;
  checkedAt: string;
}

export interface SequenceReading {
  at: number;
  sequence: number;
}

/**
 * Media seconds our pipeline produced per wall second between two playlist
 * readings. Null when unknown, or when the sequence moved implausibly — an
 * FFmpeg restart jumps it forward by design (see getNextStartNumber).
 */
export function pipelineRatio(
  prev: SequenceReading | undefined,
  cur: SequenceReading | null,
  segmentSeconds: number,
): number | null {
  if (!prev || !cur || cur.at <= prev.at) return null;
  const delta = cur.sequence - prev.sequence;
  const ratio = (delta * segmentSeconds) / ((cur.at - prev.at) / 1000);
  if (delta < 0 || ratio > 1.5) return null;
  return ratio;
}

export interface QualityPollerOpts {
  stations: Record<string, { url: string }>;
  sample: (url: string) => Promise<SourceSample>;
  /** Current EXT-X-MEDIA-SEQUENCE of our playlist for a station, or null. */
  readSequence: (station: string) => number | null;
  recorder: StatusRecorder;
  /** Receives every poll's levels (not only changes); omit to keep no level log. */
  levels?: LevelRecorder;
  now?: () => number;
  segmentSeconds?: number;
  /** Only stations this returns true for are sampled (the live ones). */
  isActive?: (station: string) => boolean;
  /**
   * Our public stream URL for a station (through Cloudflare, as a Cast device
   * reaches it), sampled alongside the source. Omit to skip the listener check.
   */
  listenerUrl?: (station: string) => string | null;
}

const round2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

export class QualityPoller {
  private readonly reports = new Map<string, QualityReport>();
  private readonly sequences = new Map<string, SequenceReading>();
  private readonly now: () => number;
  private readonly segmentSeconds: number;

  constructor(private readonly opts: QualityPollerOpts) {
    this.now = opts.now ?? Date.now;
    this.segmentSeconds = opts.segmentSeconds ?? 6;
  }

  latest(station: string): QualityReport | undefined {
    return this.reports.get(station);
  }

  async poll(station: string): Promise<void> {
    const url = this.opts.stations[station]?.url;
    if (!url) return;
    // An off-air source has no audio to grade, and sampling it costs an FFmpeg.
    if (this.opts.isActive && !this.opts.isActive(station)) return;

    // Same window for both, so a gap a listener hears can be matched against the source.
    const listenerUrl = this.opts.listenerUrl?.(station) ?? null;
    const [source, heard] = await Promise.allSettled([
      this.opts.sample(url),
      listenerUrl ? this.opts.sample(listenerUrl) : Promise.resolve(null),
    ]);
    if (source.status === 'rejected') {
      console.error(`[quality:${station}] sample failed: ${source.reason}`);
      return;
    }
    if (heard.status === 'rejected') {
      console.error(`[quality:${station}] listener sample failed: ${heard.reason}`);
    }
    const sample: SourceSample = source.value;
    const listenerSample = heard.status === 'fulfilled' ? heard.value : null;

    const at = this.now();
    const seq = this.opts.readSequence(station);
    const reading = seq === null ? null : { at, sequence: seq };
    const ours = pipelineRatio(this.sequences.get(station), reading, this.segmentSeconds);
    if (reading) this.sequences.set(station, reading);
    else this.sequences.delete(station);

    const quality = classifySample(sample);
    const listener = listenerSample ? classifySample(listenerSample) : null;
    const report: QualityReport = {
      quality,
      cause: attributeCause(quality, ours, listener),
      sourceRatio: round2(realtimeRatio(sample)),
      pipelineRatio: round2(ours),
      listener,
      listenerRatio: listenerSample ? round2(realtimeRatio(listenerSample)) : null,
      sourceDb: round1(meanLevelDb(sample)),
      listenerDb: listenerSample ? round1(meanLevelDb(listenerSample)) : null,
      checkedAt: new Date(at).toISOString(),
    };

    try {
      this.opts.levels?.record({
        ts: report.checkedAt,
        station,
        quality,
        sourceDb: report.sourceDb,
        sourceRatio: report.sourceRatio,
        ...(listenerUrl
          ? { listener, listenerDb: report.listenerDb, listenerRatio: report.listenerRatio }
          : {}),
      });
    } catch (err) {
      console.error(`[quality] could not record levels: ${err}`);
    }

    const prev = this.reports.get(station);
    this.reports.set(station, report);
    if (prev?.quality === quality && prev.listener === listener) return;

    console.log(
      `[quality:${station}] ${prev?.quality ?? 'start'} -> ${quality} (cause=${report.cause} source=${report.sourceRatio}x ours=${report.pipelineRatio}x` +
        (listenerUrl ? ` listener=${listener ?? 'failed'} ${report.listenerRatio}x)` : ')'),
    );
    try {
      this.opts.recorder.record({
        ts: report.checkedAt,
        station,
        kind: 'quality',
        from: prev?.quality ?? null,
        to: quality,
        upstreamReachable: quality !== 'down',
        cause: report.cause,
        sourceRatio: report.sourceRatio,
        pipelineRatio: report.pipelineRatio,
        sourceDb: report.sourceDb,
        ...(listenerUrl ? { listener, listenerRatio: report.listenerRatio, listenerDb: report.listenerDb } : {}),
      });
    } catch (err) {
      console.error(`[quality] could not record history: ${err}`);
    }
  }

  /**
   * Polls stations round-robin, one at a time, so a full pass takes intervalMs
   * and at most one extra FFmpeg runs at any moment.
   */
  start(intervalMs: number): void {
    const names = Object.keys(this.opts.stations);
    if (names.length === 0) return;
    let i = 0;
    let busy = false;
    setInterval(() => {
      if (busy) return;
      busy = true;
      const name = names[i++ % names.length];
      this.poll(name).finally(() => { busy = false; });
    }, intervalMs / names.length);
  }
}
