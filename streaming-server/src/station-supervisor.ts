import { RestartPolicy } from './restart-policy';
import { StatusEvent } from './status-history';

/**
 * Whether a station's source is broadcasting, as far as we can tell:
 *   'live'    — the source sent audio and our HLS FFmpeg is running for it
 *   'off-air' — the source has no audio right now (dead, 404, or a scheduled
 *               station between broadcasts). Shown on the site as "Off air".
 *   'dormant' — no audio for dormantAfterMs (7 days). Hidden from the site
 *               until the source sends audio again.
 *
 * The point is that FFmpeg only runs while there is audio. Before this, a dead
 * source made FFmpeg respawn all day, which starved the shared CPU (Golden
 * Temple went choppy) and stranded HLS segments until the volume filled
 * (2026-10-06 outage). Now a silent source costs one short HTTP probe every
 * few minutes.
 */
export type AirState = 'live' | 'off-air' | 'dormant';

/**
 * Caps how many HLS encodes run at once on the shared CPU. Priority stations
 * always get a slot (they still count toward the total), so a reliable
 * station like Golden Temple is never locked out by newer ones.
 */
export class EncoderSlots {
  private readonly held = new Set<string>();
  private readonly priority: Set<string>;

  constructor(private readonly max: number, priority: Iterable<string> = []) {
    this.priority = new Set(priority);
  }

  tryAcquire(station: string): boolean {
    if (this.held.has(station)) return true;
    if (!this.priority.has(station) && this.held.size >= this.max) return false;
    this.held.add(station);
    return true;
  }

  release(station: string): void {
    this.held.delete(station);
  }

  inUse(): number {
    return this.held.size;
  }
}

export interface SupervisorTiming {
  /** First off-air re-probe delay; doubles per failed probe up to offAirMaxMs. */
  offAirBaseMs: number;
  offAirMaxMs: number;
  dormantProbeMs: number;
  dormantAfterMs: number;
}

export const DEFAULT_TIMING: SupervisorTiming = {
  offAirBaseMs: 30_000,
  offAirMaxMs: 5 * 60_000,
  dormantProbeMs: 15 * 60_000,
  dormantAfterMs: 7 * 24 * 60 * 60_000,
};

export interface SupervisorOpts {
  /** True only if the source sent audio bytes (see upstream-monitor httpProbe). */
  probe: () => Promise<boolean>;
  startEncoder: () => void;
  /** Delete this station's HLS segments and playlist. */
  clearSegments: () => void;
  slots: EncoderSlots;
  /** Backoff for an FFmpeg that dies while its source still has audio. */
  restartPolicy?: RestartPolicy;
  /** Epoch ms the source last had audio (from /history), or null if never. */
  lastAudioAt: number | null;
  timing?: Partial<SupervisorTiming>;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
  onChange?: (from: AirState, to: AirState) => void;
}

export class StationSupervisor {
  private current: AirState;
  private lastAudioAt: number | null;
  private failedProbes = 0;
  private readonly timing: SupervisorTiming;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;
  readonly restartPolicy: RestartPolicy;

  constructor(readonly name: string, private readonly opts: SupervisorOpts) {
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? ((fn, ms) => { setTimeout(fn, ms); });
    this.restartPolicy = opts.restartPolicy ?? new RestartPolicy({ now: this.now });
    this.lastAudioAt = opts.lastAudioAt;
    this.current = this.quietState();
  }

  get state(): AirState {
    return this.current;
  }

  start(): void {
    void this.probeAndAct();
  }

  /** Our playlist is fresh, so the source has audio right now. */
  noteAudio(): void {
    this.lastAudioAt = this.now();
  }

  /** Call when the station's HLS FFmpeg exits, for any reason. */
  encoderExited(): void {
    this.opts.slots.release(this.name);
    this.schedule(() => void this.probeAndAct(), this.restartPolicy.exited());
  }

  private async probeAndAct(): Promise<void> {
    let hasAudio: boolean;
    try {
      hasAudio = await this.opts.probe();
    } catch {
      hasAudio = false;
    }

    if (hasAudio) {
      this.lastAudioAt = this.now();
      this.failedProbes = 0;
      if (this.opts.slots.tryAcquire(this.name)) {
        this.restartPolicy.started();
        this.opts.startEncoder();
        this.setState('live');
        return;
      }
      // Source is up but the CPU budget is spent; try again soon.
      this.setState('off-air');
      this.schedule(() => void this.probeAndAct(), this.timing.offAirBaseMs);
      return;
    }

    if (this.current === 'live') {
      try {
        this.opts.clearSegments();
      } catch (err) {
        console.error(`[supervisor:${this.name}] could not clear segments: ${err}`);
      }
    }
    this.failedProbes++;
    this.setState(this.quietState());
    const delay = this.current === 'dormant'
      ? this.timing.dormantProbeMs
      : Math.min(this.timing.offAirBaseMs * 2 ** (this.failedProbes - 1), this.timing.offAirMaxMs);
    this.schedule(() => void this.probeAndAct(), delay);
  }

  /** off-air or dormant, depending on how long the source has been silent. */
  private quietState(): AirState {
    if (this.lastAudioAt === null) return 'dormant';
    return this.now() - this.lastAudioAt >= this.timing.dormantAfterMs ? 'dormant' : 'off-air';
  }

  private setState(next: AirState): void {
    const prev = this.current;
    if (prev === next) return;
    this.current = next;
    console.log(`[supervisor:${this.name}] ${prev} -> ${next}`);
    this.opts.onChange?.(prev, next);
  }
}

/**
 * Epoch ms a station was last live according to its status history, or null
 * if it never was. A live stretch ends at the next status event after it
 * (including a 'from: null' event logged after a server restart); if the last
 * event is live, the station is live now.
 */
export function lastSeenLive(events: StatusEvent[], now: number): number | null {
  let last: number | null = null;
  let wasLive = false;
  for (const e of events) {
    if (e.kind === 'quality') continue;
    if (wasLive) last = Date.parse(e.ts);
    wasLive = e.to === 'live';
  }
  return wasLive ? now : last;
}
