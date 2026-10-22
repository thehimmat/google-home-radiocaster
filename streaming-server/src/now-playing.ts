import { StationStatus } from './status-tracker';
import { SourceQuality } from './stream-quality';

/**
 * The status text the Cast receiver and web player show under a station
 * (issue #26). Built from what we already track, so serving it is just a
 * read: no probing, no FFmpeg.
 *
 *   live    — playing normally (detail may warn that audio cuts out)
 *   quiet   — the source is connected but silent, e.g. Golden Temple's
 *             nightly break between Sukhasan and Amrit Vela
 *   off-air — the supervisor found no audio at the source
 *   down    — we can't get audio through. Never says whose fault (Himmat's
 *             rule for the site badge applies here too).
 *   unknown — no status check has run yet since boot
 */
export type NowPlayingState = 'live' | 'quiet' | 'off-air' | 'down' | 'unknown';

/** Daily window (UTC "HH:MM") when a station's source is expected to be quiet. */
export interface QuietHours {
  startUtc: string;
  endUtc: string;
}

export interface NowPlaying {
  station: string;
  state: NowPlayingState;
  headline: string;
  detail: string | null;
  /** When the source usually comes back. Clients render it in local time. */
  resumesAt: string | null;
  updatedAt: string;
}

export interface NowPlayingInput {
  station: string;
  status: StationStatus | undefined;
  quality?: SourceQuality;
  quietHours?: QuietHours;
  now: number;
}

const DAY_MS = 24 * 60 * 60_000;

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Epoch ms of the next occurrence of a UTC "HH:MM" at or after now. */
export function nextUtcTime(hhmm: string, now: number): number {
  const midnight = now - (now % DAY_MS);
  const at = midnight + minutesOfDay(hhmm) * 60_000;
  return at >= now ? at : at + DAY_MS;
}

function inQuietHours(q: QuietHours, now: number): boolean {
  const t = Math.floor((now % DAY_MS) / 60_000);
  const start = minutesOfDay(q.startUtc);
  const end = minutesOfDay(q.endUtc);
  return start <= end ? t >= start && t < end : t >= start || t < end;
}

export function buildNowPlaying(input: NowPlayingInput): NowPlaying {
  const { station, status, quality, quietHours, now } = input;
  const out = (state: NowPlayingState, headline: string, detail: string | null = null, resumesAt: string | null = null): NowPlaying =>
    ({ station, state, headline, detail, resumesAt, updatedAt: new Date(now).toISOString() });

  switch (status) {
    case undefined:
      return out('unknown', 'Connecting');
    case 'off-air':
      return out('off-air', 'Off air', 'This station isn\'t broadcasting right now.');
    case 'source-down':
    case 'error':
      return out('down', 'Having trouble reaching this station', 'We\'ll keep trying.');
    case 'live':
      break;
  }

  if (quality === 'silent') {
    if (quietHours && inQuietHours(quietHours, now)) {
      const resumesAt = new Date(nextUtcTime(quietHours.endUtc, now)).toISOString();
      return out('quiet', 'Kirtan is paused for the night', null, resumesAt);
    }
    return out('quiet', 'Quiet right now');
  }
  if (quality === 'choppy') return out('live', 'Live', 'Audio may cut out right now.');
  return out('live', 'Live');
}
