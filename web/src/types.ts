/** One entry from the streaming server's GET /stations, with resolved URLs. */
export interface Station {
  slug: string;
  title: string;
  subtitle: string | null;
  artworkUrl: string | null;
  /** Absolute URL of the HLS playlist — what browsers play. */
  hlsUrl: string;
  /** Absolute URL of the raw audio/aac stream — what Cast devices play. */
  streamUrl: string;
}

/**
 * Per-station status from GET /health.
 *   'live'        — streaming normally
 *   'source-down' — the broadcaster's source is unreachable (not our fault)
 *   'error'       — stale on our side (pipeline/server problem)
 */
export type StationStatus = 'live' | 'source-down' | 'error';

export interface StationHealth {
  name: string;
  processAlive: boolean | null;
  segmentFresh: boolean | null;
  upstreamReachable: boolean | null;
  status: StationStatus;
}
