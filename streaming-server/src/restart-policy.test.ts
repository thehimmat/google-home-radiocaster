import { RestartPolicy } from './restart-policy';

describe('RestartPolicy', () => {
  function setup() {
    let clock = 0;
    const policy = new RestartPolicy({ baseDelayMs: 3_000, maxDelayMs: 60_000, healthyRunMs: 60_000, now: () => clock });
    return { policy, advance: (ms: number) => { clock += ms; } };
  }

  it('restarts after the base delay the first time', () => {
    const { policy, advance } = setup();
    policy.started();
    advance(5_000);
    expect(policy.exited()).toBe(3_000);
  });

  it('backs off exponentially while FFmpeg keeps dying quickly (e.g. source 404)', () => {
    const { policy, advance } = setup();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      policy.started();
      advance(5_000);
      delays.push(policy.exited());
    }
    expect(delays).toEqual([3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000]);
  });

  it('resets the backoff once a run lasted long enough to count as healthy', () => {
    const { policy, advance } = setup();
    for (let i = 0; i < 4; i++) { policy.started(); advance(1_000); policy.exited(); }

    policy.started();
    advance(10 * 60_000);
    expect(policy.exited()).toBe(3_000);
  });

  it('knows whether the current process is still starting up (watchdog grace)', () => {
    const { policy, advance } = setup();
    policy.started();
    expect(policy.runningFor()).toBe(0);
    advance(12_000);
    expect(policy.runningFor()).toBe(12_000);
  });
});
