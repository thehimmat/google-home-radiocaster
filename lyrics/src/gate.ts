/**
 * Decides what a listener sees, from what the engine thinks it hears. The engine
 * (Kirtan Saathi) reports a shabad and line every half second or so; shown raw, that
 * flickers at shabad changes and keeps a line up long after the singing stops. The
 * by-ear review of the trial (issue #37) set these rules:
 *
 * - A shabad appears only after the engine has held it for `confirmSec`. Short wrong
 *   locks happen right where one shabad ends and the next begins, but scoring against
 *   SGPC's captions (#37, #60) showed real wrong locks are rare (about 40 s an hour) and
 *   lag at shabad changes is the bigger cost, so the confirm is short: 5 s.
 * - Quiet audio clears the display: a rolling `silenceSec` mean below `silenceDb`.
 *   Darbar Sahib's pauses sit at about -45 dB; singing rarely dips below -35 dB.
 * - The Fateh greeting, said before and after each kirtan slot, clears the display and
 *   is logged as a boundary. It is never shown as a shabad.
 * - Once `commitLines` different lines of a shabad have come through over at least
 *   `commitSec`, the gate commits to it: most shabads run 10 to 15 minutes, and other
 *   shabads sung in between (interludes) are not shown yet. For `holdSec` after
 *   committing, a different shabad must hold for `holdSwitchSec` to take over;
 *   after that, for `switchSec`. Interludes are logged so they can be shown later.
 *   Both are 20 s: on 51 captioned minutes, 5 s confirm with 20 s switch beat 15 s / 30 s
 *   on right-shabad time (75% vs 67%), lag and wrong locks alike (#60). The interlude log
 *   and score-file.ts are what to tune them with.
 * - A brief flicker back to the shown shabad (under `resumeSec`) doesn't cancel a
 *   challenger that is still being heard.
 * - Some programs are sung as a sequence of parts the corpus files as separate shabads:
 *   Asa di Vaar's saloks, pauris and chhants, the Aarti, the Bhog. `programOf` names the
 *   program a shabad belongs to. Moving between parts of the shown program takes only
 *   `partSwitchSec` and keeps the program committed; it is not an interlude. Scoring
 *   (#46) found two thirds of wrong-shabad time was a previous part still on screen.
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
  reason: 'start' | 'show' | 'switch' | 'part' | 'silence' | 'fateh' | 'lost';
}

export interface GateNote {
  t: number;
  kind: 'show' | 'switch' | 'part' | 'clear' | 'commit' | 'interlude' | 'boundary';
  shabad?: number | null;
  reason?: Display['reason'];
}

export interface GateOptions {
  /** True for the line of the Fateh greeting (see fateh.ts). */
  isBoundary?: (line: number) => boolean;
  /** The programs (bani ids) a shabad is a part of; empty for a standalone shabad. */
  programOf?: (shabad: number) => readonly string[];
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
  partSwitchSec?: number;
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
  private readonly o: Required<Omit<GateOptions, 'isBoundary' | 'programOf' | 'onNote'>>;
  private shown: Shown | null = null;
  private pending: Heard | null = null;
  private noneSince: number | null = null;
  private quiet = false;
  private levels: { t: number; power: number }[] = [];
  private idle: { since: number; reason: Display['reason'] } = { since: 0, reason: 'start' };

  constructor(private readonly opts: GateOptions = {}) {
    this.o = {
      confirmSec: opts.confirmSec ?? 5,
      silenceDb: opts.silenceDb ?? -38,
      silenceSec: opts.silenceSec ?? 6,
      lostSec: opts.lostSec ?? 10,
      commitLines: opts.commitLines ?? 3,
      commitSec: opts.commitSec ?? 60,
      holdSec: opts.holdSec ?? 300,
      holdSwitchSec: opts.holdSwitchSec ?? 20,
      switchSec: opts.switchSec ?? 20,
      resumeSec: opts.resumeSec ?? 10,
      partSwitchSec: opts.partSwitchSec ?? 3,
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
      if (s?.committedAt != null && !this.samePart(s.shabad, shabad)) this.note({ t, kind: 'interlude', shabad });
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
    if (this.samePart(s.shabad, shabad)) {
      if (held >= this.o.partSwitchSec) this.show(t, p, 'part', s.committedAt);
      return;
    }
    const need =
      s.committedAt === null ? this.o.confirmSec : t - s.committedAt < this.o.holdSec ? this.o.holdSwitchSec : this.o.switchSec;
    if (held >= need) this.show(t, p, 'switch');
  }

  /** Both shabads are parts of the same program. */
  private samePart(a: number, b: number): boolean {
    const programOf = this.opts.programOf;
    if (!programOf) return false;
    const of_b = programOf(b);
    return programOf(a).some((p) => of_b.includes(p));
  }

  private show(t: number, p: Heard, reason: 'show' | 'switch' | 'part', committedAt: number | null = null): void {
    this.shown = { ...p, shownAt: t, committedAt };
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
