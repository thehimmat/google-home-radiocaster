import { STREAM_BASE } from './api';
import type { NowPlaying } from './types';

/** Status text per station, keyed by slug (GET /now-playing). */
export async function fetchNowPlaying(base: string = STREAM_BASE): Promise<Map<string, NowPlaying>> {
  const res = await fetch(new URL('/now-playing', base));
  if (!res.ok) throw new Error(`GET /now-playing failed: ${res.status}`);
  const list: NowPlaying[] = await res.json();
  return new Map(list.map((n) => [n.station, n]));
}

export function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * The line shown under a station card, or null when the badge already says
 * it all (playing normally, off air, not checked yet).
 */
export function statusLine(np: NowPlaying, formatTime: (iso: string) => string = localTime): string | null {
  if (np.state === 'live') return np.detail;
  if (np.state === 'off-air' || np.state === 'unknown') return null;
  const parts = [`${np.headline}.`];
  if (np.detail) parts.push(np.detail);
  if (np.resumesAt) parts.push(`Usually resumes around ${formatTime(np.resumesAt)}.`);
  return parts.join(' ');
}
