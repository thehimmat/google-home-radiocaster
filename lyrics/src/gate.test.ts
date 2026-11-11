import { DisplayGate, GateNote } from './gate';

/** Feeds an engine timeline second by second, as the live engine does, and samples the display. */
function replay(
  gate: DisplayGate,
  timeline: [number, number | null, number | null][], // [t, shabad, line], each held until the next
  opts: { from: number; to: number; quietFrom?: number },
): Map<number, number | null> {
  const shown = new Map<number, number | null>();
  let i = 0;
  let cur: [number | null, number | null] = [null, null];
  for (let t = opts.from; t <= opts.to; t++) {
    while (i < timeline.length && timeline[i][0] <= t) cur = [timeline[i][1], timeline[i++][2]];
    gate.level(t, opts.quietFrom !== undefined && t >= opts.quietFrom ? -45 : -24);
    gate.event({ t, shabad: cur[0], line: cur[1] });
    const d = gate.current();
    shown.set(t, d.state === 'showing' ? d.shabad : null);
  }
  return shown;
}

/** Seconds each shabad (or nothing: -1) was on screen. */
function screenTime(shown: Map<number, number | null>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const s of shown.values()) out[s ?? -1] = (out[s ?? -1] ?? 0) + 1;
  return out;
}

const FATEH_LINE = 9999;
const make = (notes: GateNote[] = []) =>
  new DisplayGate({ isBoundary: (line) => line === FATEH_LINE, onNote: (n) => notes.push(n) });

describe('DisplayGate', () => {
  it('shows nothing until a shabad has held for 5 s', () => {
    const gate = make();
    gate.level(0, -24);
    gate.event({ t: 0, shabad: 1, line: 10 });
    gate.event({ t: 4, shabad: 1, line: 10 });
    expect(gate.current().state).toBe('idle');
    gate.event({ t: 5, shabad: 1, line: 11 });
    expect(gate.current()).toMatchObject({ state: 'showing', shabad: 1, line: 11 });
  });

  it('keeps a committed shabad through a short wrong lock (8 s blips at a shabad change)', () => {
    const gate = make();
    const shown = replay(gate, [[0, 1, 10], [30, 1, 11], [60, 1, 12], [120, 2, 20], [128, 1, 13]], { from: 0, to: 150 });
    expect(new Set(shown.values())).toEqual(new Set([null, 1]));
  });

  it('clears the display once the audio has been quiet for 6 s, and needs a fresh 5 s after', () => {
    const gate = make();
    // Singing until 100, then the -45 dB floor of a pause (Recording 1, clip a4).
    const shown = replay(gate, [[0, 1, 10]], { from: 0, to: 140, quietFrom: 100 });
    expect(shown.get(99)).toBe(1);
    expect(shown.get(106)).toBeNull();
    expect(gate.current()).toMatchObject({ state: 'idle', reason: 'silence' });

    gate.level(141, -24);
    gate.event({ t: 141, shabad: 1, line: 10 });
    expect(gate.current().state).toBe('idle');
    gate.level(146, -24);
    gate.event({ t: 146, shabad: 1, line: 10 });
    expect(gate.current().state).toBe('showing');
  });

  it('treats the Fateh greeting as a boundary: clears the display and logs it, never shows it', () => {
    const notes: GateNote[] = [];
    const gate = make(notes);
    replay(gate, [[0, 1, 10]], { from: 0, to: 30 });
    gate.event({ t: 31, shabad: 7, line: FATEH_LINE });
    expect(gate.current()).toMatchObject({ state: 'idle', reason: 'fateh' });
    expect(notes.some((n) => n.kind === 'boundary' && n.t === 31)).toBe(true);
  });

  it('keeps showing through a brief loss of lock, and clears after 10 s of none', () => {
    const gate = make();
    const shown = replay(gate, [[0, 1, 10], [40, null, null], [44, 1, 11], [60, null, null]], { from: 0, to: 80 });
    expect(shown.get(43)).toBe(1);
    expect(shown.get(50)).toBe(1);
    expect(shown.get(69)).toBe(1);
    expect(shown.get(70)).toBeNull();
  });

  describe('commitment (most shabads run 10 to 15 minutes)', () => {
    it('commits after three different lines over at least a minute', () => {
      const gate = make();
      replay(gate, [[0, 1, 10], [20, 1, 11], [40, 1, 12]], { from: 0, to: 59 });
      expect(gate.current().committed).toBe(false);
      gate.event({ t: 60, shabad: 1, line: 12 });
      expect(gate.current().committed).toBe(true);
    });

    it('does not commit on three lines heard within half a minute (the 30 s Maaroo lock)', () => {
      const gate = make();
      replay(gate, [[0, 1, 10], [10, 1, 11], [22, 1, 12]], { from: 0, to: 30 });
      expect(gate.current().committed).toBe(false);
    });

    it('holds a committed shabad through an interlude shorter than 20 s, and logs the interlude', () => {
      const notes: GateNote[] = [];
      const gate = make(notes);
      const shown = replay(gate, [[0, 1, 10], [30, 1, 11], [60, 1, 12], [120, 5, 50], [138, 1, 13]], { from: 0, to: 160 });
      expect(new Set([...shown.entries()].filter(([t]) => t >= 60).map(([, s]) => s))).toEqual(new Set([1]));
      expect(notes).toContainEqual(expect.objectContaining({ kind: 'interlude', t: 120, shabad: 5 }));
    });

    it('in its first 5 minutes, a committed shabad gives way only to one that holds for holdSwitchSec', () => {
      const gate = new DisplayGate({ holdSwitchSec: 60 });
      const shown = replay(gate, [[0, 1, 10], [30, 1, 11], [60, 1, 12], [120, 5, 50]], { from: 0, to: 200 });
      expect(shown.get(179)).toBe(1);
      expect(shown.get(180)).toBe(5);
    });

    it('after those 5 minutes, a new shabad takes over once it holds for 20 s', () => {
      const gate = make();
      const shown = replay(gate, [[0, 1, 10], [30, 1, 11], [60, 1, 12], [400, 5, 50]], { from: 0, to: 450 });
      expect(shown.get(419)).toBe(1);
      expect(shown.get(420)).toBe(5);
    });
  });

  it('keeps a new shabad pending through a brief flicker back to the shown one', () => {
    const gate = make();
    const shown = replay(gate, [[0, 1, 10], [30, 1, 11], [60, 1, 12], [100, 2, 20], [102, 1, 12], [108, 2, 21]], { from: 0, to: 140 });
    expect(shown.get(119)).toBe(1);
    expect(shown.get(120)).toBe(2); // 20 s after 100, not after 108
  });

  describe('programs sung as a sequence of parts (Asa di Vaar, Aarti, Anand Sahib, Bhog)', () => {
    // Shabads 1-3 are parts of program "ASKV"; 9 is unrelated.
    const programOf = (shabad: number) => (shabad >= 1 && shabad <= 3 ? ['ASKV'] : []);
    const makeP = (notes: GateNote[] = []) => new DisplayGate({ programOf, onNote: (n) => notes.push(n) });

    it('moves to the next part after partSwitchSec, even while the shown part is committed', () => {
      const notes: GateNote[] = [];
      const shown = replay(makeP(notes), [[0, 1, 10], [30, 1, 11], [60, 1, 12], [100, 2, 20]], { from: 0, to: 130 });
      expect(shown.get(102)).toBe(1);
      expect(shown.get(103)).toBe(2);
      expect(notes).toContainEqual(expect.objectContaining({ kind: 'part', t: 103, shabad: 2 }));
      expect(notes.some((n) => n.kind === 'interlude')).toBe(false);
    });

    it('keeps the program committed across parts', () => {
      const gate = makeP();
      replay(gate, [[0, 1, 10], [30, 1, 11], [60, 1, 12], [100, 2, 20]], { from: 0, to: 110 });
      expect(gate.current()).toMatchObject({ shabad: 2, committed: true, reason: 'part' });
    });

    it('still holds a committed program against an unrelated shabad for holdSwitchSec', () => {
      const shown = replay(makeP(), [[0, 1, 10], [30, 1, 11], [60, 1, 12], [100, 9, 90]], { from: 0, to: 130 });
      expect(shown.get(119)).toBe(1);
      expect(shown.get(120)).toBe(9);
    });

    it('ignores a part blip shorter than partSwitchSec', () => {
      const shown = replay(makeP(), [[0, 1, 10], [30, 1, 11], [60, 1, 12], [100, 3, 30], [102, 1, 13]], { from: 0, to: 120 });
      expect(new Set([...shown.entries()].filter(([t]) => t >= 60).map(([, s]) => s))).toEqual(new Set([1]));
    });
  });

  describe('replaying the by-ear trial (shabad numbers are ang numbers)', () => {
    // Recording 1: Raamkalee (964/965) then the Jap salok (8) from 2:01, with a flicker back to
    // 965 at 2:03; the singing stops at about 2:56 (-45 dB after).
    const rec1: [number, number | null, number | null][] = [
      [8, 673, 1], [21, 673, 2], [25, 964, 1], [48.5, null, null], [52, 965, 1], [56, 965, 2], [66.5, 965, 3],
      [70.5, 965, 4], [76, 965, 5], [81, 965, 6], [86.5, 965, 7], [92.5, 965, 8], [97, 965, 1], [102, 965, 2],
      [121, 8, 1], [123, 965, 5], [131, 8, 2], [131.5, 8, 3], [138, 8, 4], [146.5, 8, 5], [181, 7, FATEH_LINE], [183, 8, 5],
    ];

    it('switches to the Jap salok 20 s after it starts, and clears 6 s into the silence after it', () => {
      const shown = replay(make(), rec1, { from: 0, to: 285, quietFrom: 176 });
      expect(shown.get(140)).toBe(965);
      expect(shown.get(141)).toBe(8);
      expect(shown.get(181)).toBeNull();
      expect(screenTime(shown)[-1]).toBeGreaterThan(100);
    });

    // Engine output for Recording 2, 14:23 to 25:00, from the trial (issue #37).
    const rec2: [number, number | null, number | null][] = [
      [863, 724, 1], [870, 724, 2],
      [905, 1271, 1], // Malaar: wrong
      [913, 864, 1], [925, 864, 2],
      [949, 1301, 1], [1015, null, null],
      [1024, 1071, 1], [1034, 1071, 2], [1046, 1071, 3], [1048, 1071, 2], // Maaroo: wrong
      [1054, 1120, 1], [1059, 1120, 2], [1103, 1120, 1], [1184, 1120, 3], [1229, 1120, 4],
      [1272, 1120, 1], [1286, 1120, 2], [1329, 1120, 1], [1358, 1120, 5], [1452, 1120, 6], [1497, 1120, 1],
    ];

    // The 5 s confirm (scored on SGPC captions, #60) trades the 8 s Malaar lock for less lag.
    it('shows Malaar for its 8 s, Maaroo for 30 s, and keeps Kaydaaraa to the end', () => {
      const t = screenTime(replay(make(), rec2, { from: 855, to: 1500 }));
      expect(t[1271]).toBe(8);
      expect(t[1071]).toBe(30);
      expect(t[1120]).toBeGreaterThan(420);
    });
  });
});
