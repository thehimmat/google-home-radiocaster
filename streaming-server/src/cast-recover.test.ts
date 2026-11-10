/**
 * The Cast receiver's stall watchdog (public/cast-recover.js). A Nest Hub playing the raw
 * /stream can freeze in BUFFERING after a network blip and never resume; reloading the same
 * media rejoins the live edge (checked by hand on a Hub, 2026-11-10).
 */

interface Watchdog {
  check(): void;
}

interface WatchdogOptions {
  now: () => number;
  getState: () => string;
  getTime: () => number;
  reload: () => void;
  stallMs?: number;
}

interface CastRecover {
  createStallWatchdog(opts: WatchdogOptions): Watchdog;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createStallWatchdog } = require('../public/cast-recover.js') as CastRecover;

function setup(state = 'PLAYING') {
  const s = { clock: 0, state, time: 0, reloads: 0 };
  const dog = createStallWatchdog({
    now: () => s.clock,
    getState: () => s.state,
    getTime: () => s.time,
    reload: () => {
      s.reloads += 1;
    },
    stallMs: 10_000,
  });
  /** Advance the clock in 2 s checks, with playback moving `rate` seconds per second. */
  const run = (ms: number, rate: number) => {
    for (let t = 0; t < ms; t += 2000) {
      s.clock += 2000;
      s.time += 2 * rate;
      dog.check();
    }
  };
  return { s, run };
}

describe('createStallWatchdog', () => {
  it('leaves healthy playback alone', () => {
    const { s, run } = setup();
    run(120_000, 1);
    expect(s.reloads).toBe(0);
  });

  it('reloads once playback has been frozen for the stall time', () => {
    const { s, run } = setup();
    run(10_000, 1);
    s.state = 'BUFFERING';
    run(8_000, 0);
    expect(s.reloads).toBe(0);
    run(2_000, 0);
    expect(s.reloads).toBe(1);
  });

  it('waits a full stall time between reloads while still frozen', () => {
    const { s, run } = setup('BUFFERING');
    run(10_000, 0);
    expect(s.reloads).toBe(1);
    run(8_000, 0);
    expect(s.reloads).toBe(1);
    run(2_000, 0);
    expect(s.reloads).toBe(2);
  });

  it('does not reload while paused or idle', () => {
    for (const state of ['PAUSED', 'IDLE']) {
      const { s, run } = setup(state);
      run(60_000, 0);
      expect(s.reloads).toBe(0);
    }
  });

  it('starts the stall clock afresh after a pause', () => {
    const { s, run } = setup('PAUSED');
    run(60_000, 0);
    s.state = 'PLAYING';
    run(8_000, 0);
    expect(s.reloads).toBe(0);
  });

  it('counts a reload that restarted the clock at zero as progress once it plays', () => {
    const { s, run } = setup();
    run(2_000, 1);
    run(10_000, 0);
    expect(s.reloads).toBe(1);
    s.time = 0;
    run(30_000, 1);
    expect(s.reloads).toBe(1);
  });
});
