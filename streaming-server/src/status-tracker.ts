import { StatusEvent, StatusRecorder } from './status-history';

/**
 * Per-station status the web player and UptimeRobot both read:
 *   'live'        — fresh segments flowing
 *   'source-down' — segments stale AND the upstream source is unreachable
 *                   (the broadcaster's outage, e.g. SGPC — not our fault)
 *   'error'       — segments stale but the source answers, so the break is
 *                   on our side (FFmpeg/pipeline)
 *   'off-air'     — the StationSupervisor found no audio at the source, so no
 *                   FFmpeg runs (a scheduled station between broadcasts, or a
 *                   dormant one hidden from the site)
 */
export type StationStatus = 'live' | 'source-down' | 'error' | 'off-air';

export interface StationHealth {
  name: string;
  processAlive: boolean | null;
  segmentFresh: boolean;
  upstreamReachable: boolean | null;
  status: StationStatus;
}

/**
 * Site-level status:
 *   'ok'       — every on-air station live
 *   'degraded' — some stations out; labelled per-station on the site, no page
 *   'down'     — nothing live; the pipeline or box is broken, so page
 * 'down' deliberately ignores attribution: every source "unreachable" at once
 * is far more likely our egress than every broadcaster failing together.
 */
export type SiteStatus = 'ok' | 'degraded' | 'down';

export function siteStatus(stations: StationHealth[]): SiteStatus {
  const live = stations.filter((s) => s.status === 'live').length;
  const onAir = stations.filter((s) => s.status !== 'off-air').length;
  if (live === 0) return 'down';
  return live === onAir ? 'ok' : 'degraded';
}

export interface HealthSnapshot {
  status: SiteStatus;
  stations: StationHealth[];
}

/** Station key used in history for the site as a whole. */
export const SITE_KEY = '*';

/**
 * Evaluates station health on a timer (independent of anyone hitting /health)
 * and records every status transition, so outages leave a trail.
 */
export class StatusTracker {
  private previous = new Map<string, string>();
  private snapshot: HealthSnapshot | null = null;

  constructor(
    private readonly evaluate: () => Promise<StationHealth[]>,
    private readonly recorder: StatusRecorder,
    private readonly now: () => number = Date.now,
  ) {}

  latest(): HealthSnapshot | null {
    return this.snapshot;
  }

  async refresh(): Promise<HealthSnapshot> {
    const stations = await this.evaluate();
    const snapshot: HealthSnapshot = { status: siteStatus(stations), stations };
    const ts = new Date(this.now()).toISOString();

    for (const s of stations) this.transition(ts, s.name, s.status, s.upstreamReachable);
    this.transition(ts, SITE_KEY, snapshot.status, null);

    this.snapshot = snapshot;
    return snapshot;
  }

  start(intervalMs: number): void {
    const tick = () => {
      this.refresh().catch((err) => console.error(`[status] refresh failed: ${err}`));
    };
    tick();
    setInterval(tick, intervalMs);
  }

  private transition(ts: string, station: string, to: string, upstreamReachable: boolean | null): void {
    const from = this.previous.get(station) ?? null;
    if (from === to) return;
    this.previous.set(station, to);

    const event: StatusEvent = { ts, station, from, to, upstreamReachable };
    console.log(`[status:${station}] ${from ?? 'start'} -> ${to}`);
    try {
      this.recorder.record(event);
    } catch (err) {
      console.error(`[status] could not record history: ${err}`);
    }
  }
}
