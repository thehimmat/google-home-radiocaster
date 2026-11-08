import * as fs from 'fs';
import * as path from 'path';
import type { SourceQuality } from './stream-quality';

/**
 * Append-only log of station status transitions, so an outage can be
 * reconstructed after the fact instead of only being visible while it happens.
 * One JSON object per line on the Fly volume; tiny (a line per transition),
 * pruned to a retention window.
 */

export interface StatusEvent {
  /** ISO 8601 UTC timestamp of the transition. */
  ts: string;
  /** Station slug, or '*' for the site as a whole. */
  station: string;
  /** Previous status; null for the first observation after a (re)start. */
  from: string | null;
  to: string;
  upstreamReachable: boolean | null;
  /** Absent for status (live/error/source-down) events; 'quality' for QualityPoller events. */
  kind?: 'quality';
  /** Quality events only: who the problem points at, and the measured rates. */
  cause?: string;
  sourceRatio?: number | null;
  pipelineRatio?: number | null;
  /** Quality events with the listener check on: how our public stream sounded. */
  listener?: string | null;
  listenerRatio?: number | null;
  /** Quality events: mean loudness (dB) of the source and, with the listener check, our stream. */
  sourceDb?: number | null;
  listenerDb?: number | null;
}

/**
 * One QualityPoller sample, recorded on every poll (unlike StatusEvent, which
 * only records changes), so a quiet stretch can be blamed afterwards: source
 * quiet means the broadcaster; source loud but listener quiet means us.
 */
export interface LevelReading {
  ts: string;
  station: string;
  quality: SourceQuality;
  /** Mean source loudness in dB (see meanLevelDb); null if unmeasured. */
  sourceDb: number | null;
  sourceRatio: number | null;
  /** Listener-check fields, present only when that check is on. */
  listener?: SourceQuality | null;
  listenerDb?: number | null;
  listenerRatio?: number | null;
}

export interface HistoryQuery {
  station?: string;
  /** Epoch ms; only events at or after this time. */
  since?: number;
  /** Return only the newest N matching events. */
  limit?: number;
}

export interface Recorder<T> {
  record(entry: T): void;
}

export interface Reader<T> {
  read(query?: HistoryQuery): T[];
}

export type StatusRecorder = Recorder<StatusEvent>;
export type StatusReader = Reader<StatusEvent>;
export type LevelRecorder = Recorder<LevelReading>;
export type LevelReader = Reader<LevelReading>;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Append-only JSON-lines log of timestamped, per-station entries. */
class JsonlLog<T extends { ts: string; station: string }> implements Recorder<T>, Reader<T> {
  constructor(
    private readonly file: string,
    private readonly retentionMs = THIRTY_DAYS_MS,
    private readonly now: () => number = Date.now,
  ) {}

  record(entry: T): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
  }

  read(query: HistoryQuery = {}): T[] {
    const matches = this.readAll().filter(
      (e) =>
        (query.station === undefined || e.station === query.station) &&
        (query.since === undefined || Date.parse(e.ts) >= query.since),
    );
    return query.limit !== undefined ? matches.slice(-query.limit) : matches;
  }

  /**
   * Drop events older than the retention window. Called at boot and daily.
   * Best-effort: history must never take the server down (a full volume once
   * made this throw at boot and crash-loop the machine), so failures are logged.
   */
  prune(): void {
    const cutoff = this.now() - this.retentionMs;
    const kept = this.readAll().filter((e) => Date.parse(e.ts) >= cutoff);
    if (!fs.existsSync(this.file)) return;
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e) + '\n').join(''));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[status] could not prune ${path.basename(this.file)}: ${err}`);
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
  }

  private readAll(): T[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const events: T[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // A torn write (e.g. killed mid-append) shouldn't hide the rest of the log.
      }
    }
    return events;
  }
}

export class StatusHistory extends JsonlLog<StatusEvent> {}

/** Every QualityPoller sample's levels (see LevelReading); ~1 line per station per poll. */
export class LevelLog extends JsonlLog<LevelReading> {}
