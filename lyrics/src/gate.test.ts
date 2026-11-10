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
  it('shows nothing until a shabad has held for 15 s', () => {
    const gate = make();
    gate.level(0, -24);
    gate.event({ t: 0, shabad: 1, line: 10 });
    gate.event({ t: 14, shabad: 1, line: 10 });
    expect(gate.current().state).toBe('idle');
    gate.event({ t: 15, shabad: 1, line: 11 });
    expect(gate.current()).toMatchObject({ state: 'showing', shabad: 1, line: 11 });
  });

  it('keeps the shown shabad through a short wrong lock (8 s blips at a shabad change)', () => {
    const gate = make();
    const shown = replay(gate, [[0, 1, 10], [40, 2, 20], [48, 1, 11]], { from: 0, to: 70 });
    expect(new Set(shown.values())).toEqual(new Set([null, 1]));
  });

  it('clears the display once the audio has been quiet for 6 s, and needs a fresh 15 s after', () => {
    const gate = make();
    // Singing until 100, then the -45 dB floor of a pause (Recording 1, clip a4).
    const shown = replay(gate, [[0, 1, 10]], { from: 0, to: 140, quietFrom: 100 });
    expect(shown.get(99)).toBe(1);
    expect(shown.get(106)).toBeNull();
    expect(gate.current()).toMatchObject({ state: 'idle', reason: 'silence' });

    gate.level(141, -24);
    gate.event({ t: 141, shabad: 1, line: 10 });
    expect(gate.current().state).toBe('idle');
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

    it('holds a committed shabad through an interlude shorter than 30 s, and logs the interlude', () => {
      const notes: GateNote[] = [];
      const gate = make(notes);
      const shown = replay(gate, [[0, 1, 10], [30, 1, 11], [60, 1, 12], [120, 5, 50], [145, 1, 13]], { from: 0, to: 160 });
      expect(new Set([...shown.entries()].filter(([t]) => t >= 60).map(([, s]) => s))).toEqual(new Set([1]));
      expect(notes).toContainEqual(expect.objectContaining({ kind: 'interlude', t: 120, shabad: 5 }));
    });

    it('in its first 5 minutes, a committed shabad gives way only to one that holds for 60 s', () => {
      const gate = make();
      const shown = replay(gate, [[0, 1, 10], [30, 1, 11], [60, 1, 12], [120, 5, 50]], { from: 0, to: 200 });
      expect(shown.get(179)).toBe(1);
      expect(shown.get(180)).toBe(5);
    });

    it('after those 5 minutes, a new shabad takes over once it holds for 30 s', () => {
      const gate = make();
      const shown = replay(gate, [[0, 1, 10], [30, 1, 11], [60, 1, 12], [400, 5, 50]], { from: 0, to: 450 });
      expect(shown.get(429)).toBe(1);
      expect(shown.get(430)).toBe(5);
    });
  });

  describe('replaying the by-ear trial (shabad numbers are ang numbers)', () => {
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

    it('never shows Malaar and keeps Kaydaaraa to the end; Maaroo still shows for 30 s, only later', () => {
      const t = screenTime(replay(make(), rec2, { from: 855, to: 1500 }));
      expect(t[1271]).toBeUndefined();
      expect(t[1071]).toBe(30);
      expect(t[1120]).toBeGreaterThan(420);
    });
  });
});
