import * as fs from 'fs';
import * as path from 'path';

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
}

export interface HistoryQuery {
  station?: string;
  /** Epoch ms; only events at or after this time. */
  since?: number;
  /** Return only the newest N matching events. */
  limit?: number;
}

export interface StatusRecorder {
  record(event: StatusEvent): void;
}

export interface StatusReader {
  read(query?: HistoryQuery): StatusEvent[];
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export class StatusHistory implements StatusRecorder, StatusReader {
  constructor(
    private readonly file: string,
    private readonly retentionMs = THIRTY_DAYS_MS,
    private readonly now: () => number = Date.now,
  ) {}

  record(event: StatusEvent): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(event) + '\n');
  }

  read(query: HistoryQuery = {}): StatusEvent[] {
    const matches = this.readAll().filter(
      (e) =>
        (query.station === undefined || e.station === query.station) &&
        (query.since === undefined || Date.parse(e.ts) >= query.since),
    );
    return query.limit !== undefined ? matches.slice(-query.limit) : matches;
  }

  /** Drop events older than the retention window. Called at boot and daily. */
  prune(): void {
    const cutoff = this.now() - this.retentionMs;
    const kept = this.readAll().filter((e) => Date.parse(e.ts) >= cutoff);
    if (!fs.existsSync(this.file)) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e) + '\n').join(''));
    fs.renameSync(tmp, this.file);
  }

  private readAll(): StatusEvent[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const events: StatusEvent[] = [];
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
