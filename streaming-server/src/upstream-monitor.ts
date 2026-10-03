import * as http from 'http';
import * as https from 'https';

/**
 * Distinguishes "our pipeline is broken" from "the source broadcaster is down".
 * When a station's playlist goes stale, /health asks this monitor whether the
 * upstream URL still delivers audio. If it doesn't, the outage is the
 * broadcaster's (e.g. SGPC) and the site labels the station "source-down"
 * rather than blaming our pipeline.
 */

export type ProbeFn = (url: string) => Promise<boolean>;

export interface UpstreamStatus {
  reachable: boolean;
  /** Epoch ms of the first failed probe of the current outage; null when reachable. */
  downSince: number | null;
}

/**
 * Reachability probe: the source is up only if it answers 2xx/3xx AND sends
 * audio bytes within the timeout. Relays like radio.sikhnet.com keep answering
 * 200 after the gurdwara's own source drops, just with no data, so a status
 * code alone misattributes the broadcaster's outage to us.
 * TLS verification is disabled because upstreams like SGPC use self-signed
 * certs (FFmpeg pulls them with -tls_verify 0 for the same reason).
 */
export function httpProbe(url: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(ok);
    };
    // One deadline covers connect, headers and the first audio bytes.
    const timer = setTimeout(() => finish(false), timeoutMs);

    const onResponse = (res: http.IncomingMessage) => {
      const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400;
      if (!ok) return finish(false);
      res.on('data', (chunk: Buffer) => { if (chunk.length > 0) finish(true); });
      res.on('end', () => finish(false));
      res.on('error', () => finish(false));
    };
    // Same user-agent FFmpeg sends: some Shoutcast servers serve HTML otherwise.
    const headers = { 'User-Agent': 'WinampMPEG/5.0' };
    const req = url.startsWith('https:')
      ? https.get(url, { rejectUnauthorized: false, headers }, onResponse)
      : http.get(url, { headers }, onResponse);
    req.on('error', () => finish(false));
  });
}

interface CacheEntry {
  status: UpstreamStatus;
  checkedAt: number;
}

export class UpstreamMonitor {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<UpstreamStatus>>();

  constructor(
    private readonly stations: Record<string, { url: string }>,
    private readonly probeFn: ProbeFn = httpProbe,
    private readonly cacheMs = 30_000,
  ) {}

  /**
   * Called when a station's segments are fresh: flowing audio proves the
   * upstream works, so any recorded outage is over.
   */
  noteStreaming(station: string): void {
    const entry = this.cache.get(station);
    if (entry && !entry.status.reachable) {
      console.log(`[upstream:${station}] source recovered, segments flowing again`);
    }
    this.cache.delete(station);
  }

  /** Cached upstream reachability; probes at most once per cacheMs per station. */
  async check(station: string): Promise<UpstreamStatus> {
    const entry = this.cache.get(station);
    if (entry && Date.now() - entry.checkedAt < this.cacheMs) return entry.status;

    const pending = this.inflight.get(station);
    if (pending) return pending;

    const probe = this.runProbe(station).finally(() => this.inflight.delete(station));
    this.inflight.set(station, probe);
    return probe;
  }

  private async runProbe(station: string): Promise<UpstreamStatus> {
    const url = this.stations[station]?.url;
    const prev = this.cache.get(station)?.status;
    const reachable = url ? await this.probeFn(url) : false;

    if (!reachable && (prev?.reachable ?? true)) {
      console.log(`[upstream:${station}] source unreachable: outage is on the broadcaster's end`);
    } else if (reachable && prev && !prev.reachable) {
      console.log(`[upstream:${station}] source reachable again`);
    }

    const status: UpstreamStatus = {
      reachable,
      downSince: reachable ? null : (prev?.downSince ?? Date.now()),
    };
    this.cache.set(station, { status, checkedAt: Date.now() });
    return status;
  }
}
