import { DisplayGate } from './gate';
import { replayTrace, scoreTimeline, TraceEntry, Truth } from './score';

// Corpus stand-in: lines 10-19 are shabad 1, 20-29 shabad 2, 30-39 shabad 3.
const shabadOf = (line: number) => Math.floor(line / 10);

describe('scoreTimeline', () => {
  const truth: Truth[] = [
    { start: 0, end: 20, line: 10 },
    { start: 20, end: 40, line: 11 },
    // 40-50: no caption on screen
    { start: 50, end: 100, line: 20 },
  ];

  it('counts right, wrong, missed and unlabelled time', () => {
    const r = scoreTimeline(truth, [
      { t: 0, shabad: null, line: null },
      { t: 10, shabad: 1, line: 10 }, // right from 10 to 40
      { t: 40, shabad: 1, line: 11 }, // shown with no caption, 40-50
      { t: 50, shabad: 3, line: 30 }, // wrong 50-60
      { t: 60, shabad: 2, line: 20 }, // right 60-100
    ], { shabadOf, end: 100 });
    expect(r.labelledSec).toBe(90);
    expect(r.rightShabadSec).toBe(70);
    expect(r.wrongShabadSec).toBe(10);
    expect(r.missedSec).toBe(10);
    expect(r.unlabelledShownSec).toBe(10);
    expect(r.rightShare).toBeCloseTo(70 / 80);
    expect(r.wrongPerHour).toBeCloseTo((10 / 90) * 3600);
  });

  it('splits wrong time into lag, early and wrong locks', () => {
    const t3: Truth[] = [
      { start: 0, end: 50, line: 10 },
      { start: 50, end: 100, line: 20 },
      { start: 100, end: 200, line: 30 },
    ];
    const r = scoreTimeline(t3, [
      { t: 0, shabad: 1, line: 10 },
      { t: 60, shabad: 2, line: 20 }, // 50-60: still on shabad 1 (lag)
      { t: 90, shabad: 3, line: 30 }, // 90-100: shabad 3 before its caption (early)
      { t: 150, shabad: 4, line: 40 }, // 150-160: never sung nearby (wrong lock)
      { t: 160, shabad: 3, line: 31 },
    ], { shabadOf, end: 200 });
    expect(r.wrongShabadSec).toBe(30);
    expect(r.lagSec).toBe(10);
    expect(r.earlySec).toBe(10);
    expect(r.wrongLockSec).toBe(10);
    expect(r.wrongLockPerHour).toBeCloseTo((10 / 200) * 3600);
  });

  it('marks a line right when it matches the caption within the collar', () => {
    const r = scoreTimeline(truth, [
      { t: 0, shabad: 1, line: 10 },
      { t: 21, shabad: 1, line: 11 }, // 1 s behind the caption change at 20: forgiven
      { t: 30, shabad: 1, line: 12 }, // wrong line 30-40
      { t: 40, shabad: null, line: null },
    ], { shabadOf, end: 40, collarSec: 1 });
    expect(r.rightShabadSec).toBe(40);
    expect(r.rightLineSec).toBe(30);
  });

  it('reports how long each sung shabad took to appear', () => {
    const r = scoreTimeline(truth, [
      { t: 0, shabad: null, line: null },
      { t: 12, shabad: 1, line: 10 },
      { t: 50, shabad: 3, line: 30 },
    ], { shabadOf, end: 100 });
    expect(r.shabads).toEqual([
      { shabad: 1, start: 0, sungSec: 40, firstRight: 12, rightSec: 28 },
      { shabad: 2, start: 50, sungSec: 50, firstRight: null, rightSec: 0 },
    ]);
  });
});

describe('replayTrace', () => {
  it('turns recorded levels and engine events into raw and gated timelines', () => {
    const trace: TraceEntry[] = [];
    for (let t = 1; t <= 40; t++) {
      trace.push({ kind: 'level', t, db: t > 30 ? -50 : -24 });
      trace.push({ kind: 'event', t, shabad: 1, line: 10 });
    }
    const { raw, gated } = replayTrace(trace, () => new DisplayGate());
    expect(raw[0]).toEqual({ t: 1, shabad: 1, line: 10 });
    expect(raw).toHaveLength(1); // only changes are kept

    // Gate: confirms after 5 s, clears once the 6 s rolling mean is quiet.
    expect(gated.map((g) => [g.t, g.shabad])).toEqual([
      [1, null],
      [6, 1],
      [36, null],
    ]);
  });
});
