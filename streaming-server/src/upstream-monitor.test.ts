import { UpstreamMonitor, ProbeFn } from './upstream-monitor';

const STATIONS = {
  'golden-temple': { url: 'https://live.sgpc.net:8443/' },
  'san-jose': { url: 'https://radio.sikhnet.com/proxy/channel18/live' },
};

describe('UpstreamMonitor', () => {
  it('reports a reachable source and no outage', async () => {
    const probe: ProbeFn = async () => true;
    const monitor = new UpstreamMonitor(STATIONS, probe);

    const status = await monitor.check('golden-temple');
    expect(status.reachable).toBe(true);
    expect(status.downSince).toBeNull();
  });

  it('reports an unreachable source with an outage start time', async () => {
    const probe: ProbeFn = async () => false;
    const monitor = new UpstreamMonitor(STATIONS, probe);

    const status = await monitor.check('golden-temple');
    expect(status.reachable).toBe(false);
    expect(typeof status.downSince).toBe('number');
  });

  it('caches probe results within the cache window (one probe per station)', async () => {
    let calls = 0;
    const probe: ProbeFn = async () => {
      calls += 1;
      return false;
    };
    const monitor = new UpstreamMonitor(STATIONS, probe, 60_000);

    await monitor.check('golden-temple');
    await monitor.check('golden-temple');
    expect(calls).toBe(1);
  });

  it('dedupes concurrent probes for the same station', async () => {
    let calls = 0;
    const probe: ProbeFn = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return false;
    };
    const monitor = new UpstreamMonitor(STATIONS, probe);

    await Promise.all([monitor.check('san-jose'), monitor.check('san-jose')]);
    expect(calls).toBe(1);
  });

  it('preserves downSince across successive failed probes', async () => {
    const probe: ProbeFn = async () => false;
    const monitor = new UpstreamMonitor(STATIONS, probe, 0); // no caching

    const first = await monitor.check('golden-temple');
    await new Promise((r) => setTimeout(r, 5));
    const second = await monitor.check('golden-temple');
    expect(second.downSince).toBe(first.downSince);
  });

  it('clears recorded outage once segments flow again', async () => {
    const probe: ProbeFn = async () => false;
    const monitor = new UpstreamMonitor(STATIONS, probe, 60_000);

    await monitor.check('golden-temple'); // records outage, cached
    monitor.noteStreaming('golden-temple'); // recovery observed via fresh segments

    let probedAfterRecovery = false;
    const monitor2 = new UpstreamMonitor(
      STATIONS,
      async () => {
        probedAfterRecovery = true;
        return true;
      },
      60_000,
    );
    await monitor2.check('golden-temple');
    monitor2.noteStreaming('golden-temple');
    const status = await monitor2.check('golden-temple');
    expect(probedAfterRecovery).toBe(true);
    expect(status.reachable).toBe(true);
  });

  it('treats an unknown station as unreachable', async () => {
    const probe: ProbeFn = async () => true;
    const monitor = new UpstreamMonitor(STATIONS, probe);
    const status = await monitor.check('does-not-exist');
    expect(status.reachable).toBe(false);
  });
});
