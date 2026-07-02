import * as http from 'http';
import * as https from 'https';

/**
 * Distinguishes "our pipeline is broken" from "the source broadcaster is down".
 * When a station's playlist goes stale, /health asks this monitor whether the
 * upstream URL still answers. If it doesn't, the outage is the broadcaster's
 * (e.g. SGPC), we report it per-station, and /health stays 200 so UptimeRobot
 * only pages for failures on our side.
 */

export type ProbeFn = (url: string) => Promise<boolean>;

export interface UpstreamStatus {
  reachable: boolean;
  /** Epoch ms of the first failed probe of the current outage; null when reachable. */
  downSince: number | null;
}

/**
 * Reachability probe: any 2xx/3xx response counts as "the source is up".
 * TLS verification is disabled because upstreams like SGPC use self-signed
 * certs (FFmpeg pulls them with -tls_verify 0 for the same reason), and the
 * only question here is whether the origin answers.
 */
export function httpProbe(url: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const onResponse = (res: http.IncomingMessage) => {
      const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400;
      res.destroy();
      resolve(ok);
    };
    const req = url.startsWith('https:')
      ? https.get(url, { rejectUnauthorized: false, timeout: timeoutMs }, onResponse)
      : http.get(url, { timeout: timeoutMs }, onResponse);
    req.on('timeout', () => req.destroy(new Error('probe timeout')));
    req.on('error', () => resolve(false));
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
