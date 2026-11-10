/**
 * Decides what a listener sees, from what the engine thinks it hears. The engine
 * (Kirtan Saathi) reports a shabad and line every half second or so; shown raw, that
 * flickers at shabad changes and keeps a line up long after the singing stops. The
 * by-ear review of the trial (issue #37) set these rules:
 *
 * - A shabad appears only after the engine has held it for `confirmSec`. Short wrong
 *   locks happen right where one shabad ends and the next begins.
 * - Quiet audio clears the display: a rolling `silenceSec` mean below `silenceDb`.
 *   Darbar Sahib's pauses sit at about -45 dB; singing rarely dips below -35 dB.
 * - The Fateh greeting, said before and after each kirtan slot, clears the display and
 *   is logged as a boundary. It is never shown as a shabad.
 * - Once `commitLines` different lines of a shabad have come through over at least
 *   `commitSec`, the gate commits to it: most shabads run 10 to 15 minutes, and other
 *   shabads sung in between (interludes) are not shown yet. For `holdSec` after
 *   committing, a different shabad must hold for `holdSwitchSec` to take over;
 *   after that, for `switchSec`. Interludes are logged so they can be shown later.
 *   Both are 30 s for now: in the trial, a 60 s hold kept Raamkalee up for 47 s while
 *   the Jap salok after it was being sung, and no reviewed audio had an interlude to
 *   weigh against that. The interlude log is what to tune them with.
 * - A brief flicker back to the shown shabad (under `resumeSec`) doesn't cancel a
 *   challenger that is still being heard.
 *
 * Times are stream seconds. Pure logic: the caller feeds levels and engine events.
 */

export interface GateEvent {
  t: number;
  shabad: number | null;
  line: number | null;
}

export interface Display {
  state: 'idle' | 'showing';
  shabad: number | null;
  line: number | null;
  /** Stream time the current shabad appeared, or the display went idle. */
  since: number;
  committed: boolean;
  /** Why the display last changed. */
  reason: 'start' | 'show' | 'switch' | 'silence' | 'fateh' | 'lost';
}

export interface GateNote {
  t: number;
  kind: 'show' | 'switch' | 'clear' | 'commit' | 'interlude' | 'boundary';
  shabad?: number | null;
  reason?: Display['reason'];
}

export interface GateOptions {
  /** True for the line of the Fateh greeting (see fateh.ts). */
  isBoundary?: (line: number) => boolean;
  onNote?: (note: GateNote) => void;
  confirmSec?: number;
  silenceDb?: number;
  silenceSec?: number;
  lostSec?: number;
  commitLines?: number;
  commitSec?: number;
  holdSec?: number;
  holdSwitchSec?: number;
  switchSec?: number;
  resumeSec?: number;
}

interface Heard {
  shabad: number;
  line: number | null;
  /** When the engine first reported this shabad. */
  firstHeard: number;
  lines: Set<number>;
  /** When the shown shabad came back while this one was pending, if it has since. */
  interruptedAt?: number | null;
}

interface Shown extends Heard {
  shownAt: number;
  committedAt: number | null;
}

export class DisplayGate {
  private readonly o: Required<Omit<GateOptions, 'isBoundary' | 'onNote'>>;
  private shown: Shown | null = null;
  private pending: Heard | null = null;
  private noneSince: number | null = null;
  private quiet = false;
  private levels: { t: number; power: number }[] = [];
  private idle: { since: number; reason: Display['reason'] } = { since: 0, reason: 'start' };

  constructor(private readonly opts: GateOptions = {}) {
    this.o = {
      confirmSec: opts.confirmSec ?? 15,
      silenceDb: opts.silenceDb ?? -38,
      silenceSec: opts.silenceSec ?? 6,
      lostSec: opts.lostSec ?? 10,
      commitLines: opts.commitLines ?? 3,
      commitSec: opts.commitSec ?? 60,
      holdSec: opts.holdSec ?? 300,
      holdSwitchSec: opts.holdSwitchSec ?? 30,
      switchSec: opts.switchSec ?? 30,
      resumeSec: opts.resumeSec ?? 10,
    };
  }

  current(): Display {
    const s = this.shown;
    if (!s) return { state: 'idle', shabad: null, line: null, since: this.idle.since, committed: false, reason: this.idle.reason };
    return {
      state: 'showing',
      shabad: s.shabad,
      line: s.line,
      since: s.shownAt,
      committed: s.committedAt !== null,
      reason: this.shownReason,
    };
  }

  private shownReason: Display['reason'] = 'show';

  /** Loudness (dB) of the second of audio ending at `t`. */
  level(t: number, db: number): void {
    this.levels.push({ t, power: 10 ** (db / 10) });
    while (this.levels.length > 0 && this.levels[0].t <= t - this.o.silenceSec) this.levels.shift();
    const covered = this.levels.length > 0 && t - this.levels[0].t >= this.o.silenceSec - 1;
    const mean = this.levels.reduce((sum, l) => sum + l.power, 0) / Math.max(1, this.levels.length);
    this.quiet = covered && 10 * Math.log10(mean) < this.o.silenceDb;
    if (this.quiet) this.clear(t, 'silence');
  }

  event(ev: GateEvent): void {
    const { t, shabad, line } = ev;
    if (this.quiet) return;

    if (line !== null && this.opts.isBoundary?.(line)) {
      this.note({ t, kind: 'boundary' });
      this.clear(t, 'fateh');
      return;
    }

    if (shabad === null) {
      this.pending = null;
      this.noneSince ??= t;
      if (t - this.noneSince >= this.o.lostSec) this.clear(t, 'lost');
      return;
    }
    this.noneSince = null;

    const s = this.shown;
    if (s && shabad === s.shabad) {
      // A brief return to the shown shabad (the engine flickering back) keeps a challenger's claim;
      // only `resumeSec` of it drops the challenger.
      if (this.pending) {
        this.pending.interruptedAt ??= t;
        if (t - this.pending.interruptedAt >= this.o.resumeSec) this.pending = null;
      }
      s.line = line;
      if (line !== null) s.lines.add(line);
      if (s.committedAt === null && s.lines.size >= this.o.commitLines && t - s.firstHeard >= this.o.commitSec) {
        s.committedAt = t;
        this.note({ t, kind: 'commit', shabad });
      }
      return;
    }

    if (!this.pending || this.pending.shabad !== shabad) {
      this.pending = { shabad, line, firstHeard: t, lines: new Set() };
      if (s?.committedAt != null) this.note({ t, kind: 'interlude', shabad });
    }
    const p = this.pending;
    p.interruptedAt = null;
    p.line = line;
    if (line !== null) p.lines.add(line);

    const held = t - p.firstHeard;
    if (!s) {
      if (held >= this.o.confirmSec) this.show(t, p, 'show');
      return;
    }
    const need =
      s.committedAt === null ? this.o.confirmSec : t - s.committedAt < this.o.holdSec ? this.o.holdSwitchSec : this.o.switchSec;
    if (held >= need) this.show(t, p, 'switch');
  }

  private show(t: number, p: Heard, reason: 'show' | 'switch'): void {
    this.shown = { ...p, shownAt: t, committedAt: null };
    this.pending = null;
    this.shownReason = reason;
    this.note({ t, kind: reason, shabad: p.shabad });
  }

  private clear(t: number, reason: Display['reason']): void {
    this.pending = null;
    if (!this.shown) return;
    this.shown = null;
    this.idle = { since: t, reason };
    this.note({ t, kind: 'clear', reason });
  }

  private note(n: GateNote): void {
    this.opts.onNote?.(n);
  }
}
