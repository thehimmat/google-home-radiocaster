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
 *   'off-air'     — the source isn't broadcasting right now (e.g. a station
 *                   that only broadcasts at set times)
 */
export type StationStatus = 'live' | 'source-down' | 'error' | 'off-air';

/** Latest source audio-quality sample for a station (server's QualityPoller). */
export interface StationQuality {
  quality: 'down' | 'silent' | 'quiet' | 'choppy' | 'healthy';
}

export interface StationHealth {
  name: string;
  processAlive: boolean | null;
  segmentFresh: boolean | null;
  upstreamReachable: boolean | null;
  status: StationStatus;
  /** Null/absent until the station's source has been sampled. */
  quality?: StationQuality | null;
}

/**
 * What a listener sees on a station card. Deliberately says nothing about
 * whose fault a problem is: the server's attribution (status 'source-down'
 * vs 'error', quality.cause) is for /history and debugging, not the site.
 */
export type StationBadge = 'down' | 'silent' | 'quiet' | 'choppy' | 'healthy' | 'off-air';

/** The shabad being sung, from GET /now-playing/:station (the lyrics follower; Golden Temple only). */
export interface NowPlaying {
  station: string;
  state: 'showing';
  committed: boolean;
  shabad: { id: string; source: string; section: string; page: number };
  /** The line being sung: its position in `lines` and its text. */
  line: { index: number; text: string } | null;
  /** The whole shabad, in order. */
  lines: string[];
}
