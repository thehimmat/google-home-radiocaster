import { StatusRecorder } from './status-history';
import {
  attributeCause,
  Cause,
  classifySample,
  realtimeRatio,
  SourceQuality,
  SourceSample,
} from './stream-quality';

/**
 * Periodically samples each station's source (see stream-quality) and compares
 * it with how fast our own HLS pipeline is producing audio, so "it's cutting
 * out" can be pinned on the broadcaster or on us. Results show on /health and
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
  now?: () => number;
  segmentSeconds?: number;
}

const round2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

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

    let sample: SourceSample;
    try {
      sample = await this.opts.sample(url);
    } catch (err) {
      console.error(`[quality:${station}] sample failed: ${err}`);
      return;
    }

    const at = this.now();
    const seq = this.opts.readSequence(station);
    const reading = seq === null ? null : { at, sequence: seq };
    const ours = pipelineRatio(this.sequences.get(station), reading, this.segmentSeconds);
    if (reading) this.sequences.set(station, reading);
    else this.sequences.delete(station);

    const quality = classifySample(sample);
    const report: QualityReport = {
      quality,
      cause: attributeCause(quality, ours),
      sourceRatio: round2(realtimeRatio(sample)),
      pipelineRatio: round2(ours),
      checkedAt: new Date(at).toISOString(),
    };

    const prev = this.reports.get(station);
    this.reports.set(station, report);
    if (prev?.quality === quality) return;

    console.log(
      `[quality:${station}] ${prev?.quality ?? 'start'} -> ${quality} (cause=${report.cause} source=${report.sourceRatio}x ours=${report.pipelineRatio}x)`,
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
