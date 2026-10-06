/**
 * When to respawn a station's HLS FFmpeg after it exits.
 *
 * A dead source (e.g. a SikhNet relay answering 404 off-schedule) makes FFmpeg
 * exit within seconds; respawning every 3s forever burns the shared CPU that
 * the healthy stations' encoders need, which slows them below real time.
 * So quick deaths back off exponentially, and a run that lasted healthyRunMs
 * resets the backoff.
 */
export interface RestartPolicyOpts {
  baseDelayMs?: number;
  maxDelayMs?: number;
  healthyRunMs?: number;
  now?: () => number;
}

export class RestartPolicy {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly healthyRunMs: number;
  private readonly now: () => number;
  private startedAt = 0;
  private quickFailures = 0;

  constructor(opts: RestartPolicyOpts = {}) {
    this.baseDelayMs = opts.baseDelayMs ?? 3_000;
    this.maxDelayMs = opts.maxDelayMs ?? 60_000;
    this.healthyRunMs = opts.healthyRunMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  started(): void {
    this.startedAt = this.now();
  }

  /** How long the current process has been running, in ms. */
  runningFor(): number {
    return this.now() - this.startedAt;
  }

  /** Call when FFmpeg exits; returns how long to wait before respawning. */
  exited(): number {
    if (this.runningFor() >= this.healthyRunMs) this.quickFailures = 0;
    const delay = Math.min(this.baseDelayMs * 2 ** this.quickFailures, this.maxDelayMs);
    this.quickFailures++;
    return delay;
  }
}
