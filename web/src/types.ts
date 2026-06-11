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

export interface StationHealth {
  name: string;
  processAlive: boolean | null;
  segmentFresh: boolean | null;
}
