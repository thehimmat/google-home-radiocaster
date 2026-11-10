/**
 * Scores what the display showed against ground truth (issue #37). Truth comes from SGPC's
 * broadcasts, which put the line being sung on screen: Kirtan Saathi's caption labeller reads
 * it into time-aligned corpus lines. The operator changes the caption by hand, usually about a
 * second behind the singing, so line timing gets a collar.
 *
 * Pure logic. score-file.ts records a trace from a recording and feeds it here, so the gate can
 * be re-scored with other settings without decoding the audio again.
 */
import { Display, GateEvent } from './gate';

/** A caption on screen: corpus line `line` from `start` to `end` (seconds). */
export interface Truth {
  start: number;
  end: number;
  line: number;
}

/** What was on screen from `t` until the next entry. shabad null: nothing shown. */
export interface Shown {
  t: number;
  shabad: number | null;
  line: number | null;
}

export interface ScoreOptions {
  shabadOf: (line: number) => number;
  /** End of the scored audio (seconds). */
  end: number;
  /** Sampling step (seconds). */
  step?: number;
  /** A shown line counts as right if the caption showed it within this many seconds. */
  collarSec?: number;
  /** Showing a shabad captioned this recently counts as lag, not a wrong lock. */
  lagWindowSec?: number;
  /** Showing a shabad captioned this soon after counts as early, not a wrong lock. */
  earlyWindowSec?: number;
}

export interface ShabadScore {
  shabad: number;
  /** When its first caption appeared. */
  start: number;
  /** Seconds it was captioned. */
  sungSec: number;
  /** When it was first shown while captioned, or null if never. */
  firstRight: number | null;
  rightSec: number;
}

export interface Score {
  /** Seconds with a caption on screen. */
  labelledSec: number;
  rightShabadSec: number;
  /** Showing a different shabad from the caption's: lag + early + wrong locks. */
  wrongShabadSec: number;
  /** Still showing a shabad after the caption moved on from it. */
  lagSec: number;
  /** Showing the next shabad before its caption appeared. */
  earlySec: number;
  /** Showing a shabad not captioned anywhere nearby: the engine heard the wrong shabad. */
  wrongLockSec: number;
  /** Captioned, nothing shown. */
  missedSec: number;
  /** Shown with no caption (between shabads, or captions the labeller could not read). */
  unlabelledShownSec: number;
  rightLineSec: number;
  /** Of the time something was shown during captions, the share that was the right shabad. */
  rightShare: number;
  /** Wrong-shabad seconds per hour of captioned audio (STTM's production build: about 111). */
  wrongPerHour: number;
  wrongLockPerHour: number;
  shabads: ShabadScore[];
}

function at<T extends { t: number }>(timeline: T[], t: number, from: { i: number }): T | null {
  while (from.i + 1 < timeline.length && timeline[from.i + 1].t <= t) from.i++;
  return timeline[from.i] && timeline[from.i].t <= t ? timeline[from.i] : null;
}

export function scoreTimeline(truth: Truth[], timeline: Shown[], opts: ScoreOptions): Score {
  const step = opts.step ?? 0.5;
  const collar = opts.collarSec ?? 1;
  const lagWindow = opts.lagWindowSec ?? 180;
  const earlyWindow = opts.earlyWindowSec ?? 60;
  const sorted = [...truth].sort((a, b) => a.start - b.start);
  const truthAt = (t: number) => sorted.find((s) => t >= s.start && t < s.end) ?? null;
  const lineNear = (t: number, line: number) =>
    sorted.some((s) => s.line === line && s.start - collar <= t && t < s.end + collar);

  const captionedNear = (shabad: number, from: number, to: number) =>
    sorted.some((s) => opts.shabadOf(s.line) === shabad && s.start < to && s.end > from);

  let labelled = 0, right = 0, wrong = 0, missed = 0, unlabelled = 0, rightLine = 0, lag = 0, early = 0, wrongLock = 0;
  const byShabad = new Map<number, ShabadScore>();
  const cursor = { i: 0 };
  for (let t = step / 2; t < opts.end; t += step) {
    const g = truthAt(t);
    const p = at(timeline, t, cursor);
    const shown = p && p.shabad !== null ? p : null;
    if (!g) {
      if (shown) unlabelled += step;
      continue;
    }
    labelled += step;
    const gs = opts.shabadOf(g.line);
    let entry = byShabad.get(gs);
    if (!entry) {
      entry = { shabad: gs, start: g.start, sungSec: 0, firstRight: null, rightSec: 0 };
      byShabad.set(gs, entry);
    }
    entry.sungSec += step;
    if (!shown) {
      missed += step;
    } else if (shown.shabad === gs) {
      right += step;
      entry.rightSec += step;
      entry.firstRight ??= shown.t > entry.start ? shown.t : entry.start;
      if (shown.line !== null && lineNear(t, shown.line)) rightLine += step;
    } else {
      wrong += step;
      const ss = shown.shabad as number;
      if (captionedNear(ss, t - lagWindow, g.start)) lag += step;
      else if (captionedNear(ss, g.end, t + earlyWindow)) early += step;
      else wrongLock += step;
    }
  }
  return {
    labelledSec: labelled,
    rightShabadSec: right,
    wrongShabadSec: wrong,
    lagSec: lag,
    earlySec: early,
    wrongLockSec: wrongLock,
    missedSec: missed,
    unlabelledShownSec: unlabelled,
    rightLineSec: rightLine,
    rightShare: right + wrong > 0 ? right / (right + wrong) : 0,
    wrongPerHour: labelled > 0 ? (wrong / labelled) * 3600 : 0,
    wrongLockPerHour: labelled > 0 ? (wrongLock / labelled) * 3600 : 0,
    shabads: [...byShabad.values()].sort((a, b) => a.start - b.start),
  };
}

/** One second's loudness, or one engine report, in stream order. */
export type TraceEntry = ({ kind: 'level'; db: number } & { t: number }) | ({ kind: 'event' } & GateEvent);

export interface GateLikeForReplay {
  level(t: number, db: number): void;
  event(ev: GateEvent): void;
  current(): Display;
}

/** Raw engine output and the gated display, as change-only timelines. */
export function replayTrace(trace: TraceEntry[], makeGate: () => GateLikeForReplay): { raw: Shown[]; gated: Shown[] } {
  const gate = makeGate();
  const raw: Shown[] = [];
  const gated: Shown[] = [];
  const push = (list: Shown[], s: Shown) => {
    const last = list[list.length - 1];
    if (!last || last.shabad !== s.shabad || last.line !== s.line) list.push(s);
  };
  for (const e of trace) {
    if (e.kind === 'level') {
      gate.level(e.t, e.db);
    } else {
      push(raw, { t: e.t, shabad: e.shabad, line: e.shabad === null ? null : e.line });
      gate.event({ t: e.t, shabad: e.shabad, line: e.line });
    }
    const d = gate.current();
    push(gated, { t: e.t, shabad: d.state === 'showing' ? d.shabad : null, line: d.state === 'showing' ? d.line : null });
  }
  return { raw, gated };
}
