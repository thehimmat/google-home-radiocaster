import type { Station, StationHealth, StationStatus } from './types';

// The stream origin is configurable so the static bundle is host-portable:
// set VITE_STREAM_BASE=http://localhost:3001 to develop against a local
// streaming server (CORS is open on all of its JSON/stream endpoints).
export const STREAM_BASE: string =
  import.meta.env?.VITE_STREAM_BASE ?? 'https://stream.atthebunga.com';

interface RawStation {
  slug: string;
  title: string;
  subtitle: string | null;
  artworkUrl: string | null;
  hlsPath: string;
  streamPath: string;
}

/** Resolve the server's relative paths against a base origin. */
export function toStation(raw: RawStation, base: string): Station {
  return {
    slug: raw.slug,
    title: raw.title,
    subtitle: raw.subtitle,
    artworkUrl: raw.artworkUrl,
    hlsUrl: new URL(raw.hlsPath, base).toString(),
    streamUrl: new URL(raw.streamPath, base).toString(),
  };
}

export async function fetchStations(base: string = STREAM_BASE): Promise<Station[]> {
  const res = await fetch(new URL('/stations', base));
  if (!res.ok) throw new Error(`GET /stations failed: ${res.status}`);
  const raw: RawStation[] = await res.json();
  return raw.map((r) => toStation(r, base));
}

/**
 * Per-station status keyed by slug. /health responds 503 when a station fails
 * on our side, but the body still carries per-station data (including source
 * outages, which stay 200), so non-ok statuses are parsed, not thrown.
 * Missing/unknown status is treated as 'error' so the UI never silently hides a
 * dead stream.
 */
export async function fetchHealth(base: string = STREAM_BASE): Promise<Map<string, StationStatus>> {
  const res = await fetch(new URL('/health', base));
  const body: { stations: StationHealth[] } = await res.json();
  return new Map(
    body.stations.map((s) => {
      const status: StationStatus =
        s.status === 'live' || s.status === 'source-down' || s.status === 'error'
          ? s.status
          : s.segmentFresh === true
            ? 'live'
            : 'error';
      return [s.name, status];
    }),
  );
}
