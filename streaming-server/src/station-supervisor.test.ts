import { EncoderSlots, lastSeenLive, StationSupervisor, SupervisorOpts } from './station-supervisor';
import { RestartPolicy } from './restart-policy';
import { StatusEvent } from './status-history';

const DAY = 24 * 60 * 60 * 1000;

function setup(overrides: Partial<SupervisorOpts> = {}) {
  let clock = 1_000_000_000_000;
  const now = () => clock;
  const scheduled: { fn: () => void; ms: number }[] = [];
  let probeResult = true;
  const calls = { probes: 0, starts: 0, clears: 0 };
  const changes: [string, string][] = [];

  const sup = new StationSupervisor('bangla-sahib', {
    probe: async () => { calls.probes++; return probeResult; },
    startEncoder: () => { calls.starts++; },
    clearSegments: () => { calls.clears++; },
    slots: new EncoderSlots(4),
    restartPolicy: new RestartPolicy({ now }),
    lastAudioAt: clock - DAY,
    now,
    schedule: (fn, ms) => { scheduled.push({ fn, ms }); },
    onChange: (from, to) => changes.push([from, to]),
    ...overrides,
  });

  /** Run the most recently scheduled probe and let it settle. */
  async function runNext() {
    const next = scheduled.pop();
    if (!next) throw new Error('nothing scheduled');
    clock += next.ms;
    next.fn();
    await flush();
  }

  return {
    sup, calls, scheduled, changes, runNext,
    setProbe: (ok: boolean) => { probeResult = ok; },
    advance: (ms: number) => { clock += ms; },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('StationSupervisor', () => {
  it('starts the encoder only after a probe gets audio', async () => {
    const t = setup();
    t.sup.start();
    await flush();
    expect(t.calls).toEqual({ probes: 1, starts: 1, clears: 0 });
    expect(t.sup.state).toBe('live');
  });

  it('never starts FFmpeg for a dead source, and backs off probing to 5 minutes', async () => {
    const t = setup();
    t.setProbe(false);
    t.sup.start();
    await flush();
    const delays = [t.scheduled[0].ms];
    for (let i = 0; i < 6; i++) {
      await t.runNext();
      delays.push(t.scheduled[0].ms);
    }
    expect(t.calls.starts).toBe(0);
    expect(t.sup.state).toBe('off-air');
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  });

  it('goes live again when an off-air source comes back (scheduled broadcast)', async () => {
    const t = setup();
    t.setProbe(false);
    t.sup.start();
    await flush();
    t.setProbe(true);
    await t.runNext();
    expect(t.sup.state).toBe('live');
    expect(t.calls.starts).toBe(1);
    expect(t.changes).toEqual([['off-air', 'live']]);
  });

  it('when FFmpeg exits and the source is gone, goes off-air and clears its segments', async () => {
    const t = setup();
    t.sup.start();
    await flush();
    t.setProbe(false);
    t.sup.encoderExited();
    await t.runNext();
    expect(t.sup.state).toBe('off-air');
    expect(t.calls.clears).toBe(1);
    expect(t.calls.starts).toBe(1);
  });

  it('when FFmpeg exits but the source still has audio, restarts it after the restart backoff', async () => {
    const t = setup();
    t.sup.start();
    await flush();
    t.advance(5_000);
    t.sup.encoderExited();
    expect(t.scheduled[0].ms).toBe(3_000);
    await t.runNext();
    expect(t.sup.state).toBe('live');
    expect(t.calls.starts).toBe(2);
    expect(t.calls.clears).toBe(0);
  });

  it('goes dormant after 7 days without audio, and then probes every 15 minutes', async () => {
    const t = setup();
    t.setProbe(false);
    t.sup.start();
    await flush();
    t.advance(7 * DAY);
    await t.runNext();
    expect(t.sup.state).toBe('dormant');
    expect(t.scheduled[0].ms).toBe(15 * 60_000);
  });

  it('starts dormant when it has never been heard live, and wakes on audio', async () => {
    const t = setup({ lastAudioAt: null });
    expect(t.sup.state).toBe('dormant');
    t.sup.start();
    await flush();
    expect(t.sup.state).toBe('live');
  });

  it('noteAudio keeps a live station from counting toward dormancy', async () => {
    const t = setup();
    t.sup.start();
    await flush();
    t.advance(8 * DAY);
    t.sup.noteAudio();
    t.setProbe(false);
    t.sup.encoderExited();
    await t.runNext();
    expect(t.sup.state).toBe('off-air');
  });

  it('stays off-air while every encoder slot is taken, then starts when one frees up', async () => {
    const slots = new EncoderSlots(1);
    slots.tryAcquire('golden-temple-ish');
    const t = setup({ slots });
    t.sup.start();
    await flush();
    expect(t.sup.state).toBe('off-air');
    expect(t.calls.starts).toBe(0);
    expect(t.scheduled[0].ms).toBe(30_000);

    slots.release('golden-temple-ish');
    await t.runNext();
    expect(t.sup.state).toBe('live');
  });

  it('releases its slot when FFmpeg exits', async () => {
    const slots = new EncoderSlots(1);
    const t = setup({ slots });
    t.sup.start();
    await flush();
    expect(slots.inUse()).toBe(1);
    t.sup.encoderExited();
    expect(slots.inUse()).toBe(0);
  });
});

describe('EncoderSlots', () => {
  it('caps concurrent encoders', () => {
    const slots = new EncoderSlots(2);
    expect(slots.tryAcquire('a')).toBe(true);
    expect(slots.tryAcquire('b')).toBe(true);
    expect(slots.tryAcquire('c')).toBe(false);
    slots.release('a');
    expect(slots.tryAcquire('c')).toBe(true);
  });

  it('lets priority stations through even when full, so Golden Temple is never locked out', () => {
    const slots = new EncoderSlots(1, ['golden-temple']);
    expect(slots.tryAcquire('a')).toBe(true);
    expect(slots.tryAcquire('golden-temple')).toBe(true);
    expect(slots.inUse()).toBe(2);
  });

  it('is idempotent per station', () => {
    const slots = new EncoderSlots(1);
    expect(slots.tryAcquire('a')).toBe(true);
    expect(slots.tryAcquire('a')).toBe(true);
    expect(slots.inUse()).toBe(1);
  });
});

describe('lastSeenLive', () => {
  const ev = (ts: string, from: string | null, to: string, kind?: 'quality'): StatusEvent =>
    ({ ts, station: 's', from, to, upstreamReachable: null, ...(kind ? { kind } : {}) });
  const now = Date.parse('2026-10-08T00:00:00Z');

  it('is null when the station was never live', () => {
    expect(lastSeenLive([ev('2026-10-01T00:00:00Z', null, 'source-down')], now)).toBeNull();
  });

  it('is the time the station stopped being live', () => {
    expect(lastSeenLive([
      ev('2026-10-01T00:00:00Z', null, 'live'),
      ev('2026-10-02T00:00:00Z', 'live', 'off-air'),
    ], now)).toBe(Date.parse('2026-10-02T00:00:00Z'));
  });

  it('counts a restart (from null) after live as the end of that live stretch', () => {
    expect(lastSeenLive([
      ev('2026-10-01T00:00:00Z', null, 'live'),
      ev('2026-10-03T00:00:00Z', null, 'off-air'),
    ], now)).toBe(Date.parse('2026-10-03T00:00:00Z'));
  });

  it('is now when the last event is live', () => {
    expect(lastSeenLive([ev('2026-10-01T00:00:00Z', null, 'live')], now)).toBe(now);
  });

  it('ignores quality events', () => {
    expect(lastSeenLive([ev('2026-10-01T00:00:00Z', null, 'healthy', 'quality')], now)).toBeNull();
  });
});
