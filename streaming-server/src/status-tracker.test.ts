import { StatusTracker, StationHealth, siteStatus } from './status-tracker';
import { StatusEvent } from './status-history';

function health(name: string, status: StationHealth['status'], upstreamReachable: boolean | null = null): StationHealth {
  return { name, processAlive: true, segmentFresh: status === 'live', upstreamReachable, status };
}

describe('siteStatus', () => {
  it('is ok when every station is live', () => {
    expect(siteStatus([health('a', 'live'), health('b', 'live')])).toBe('ok');
  });

  it('is degraded (not down) when only some stations are out, whatever the cause', () => {
    expect(siteStatus([health('a', 'live'), health('b', 'error')])).toBe('degraded');
    expect(siteStatus([health('a', 'live'), health('b', 'source-down')])).toBe('degraded');
  });

  it('is down when no station is live, even if every outage looks like the source', () => {
    // All sources "unreachable" at once is far more likely our egress than six broadcasters.
    expect(siteStatus([health('a', 'source-down'), health('b', 'source-down')])).toBe('down');
    expect(siteStatus([health('a', 'error')])).toBe('down');
  });

  it('is down when there are no stations at all', () => {
    expect(siteStatus([])).toBe('down');
  });
});

describe('StatusTracker', () => {
  function setup(sequence: StationHealth[][]) {
    const events: StatusEvent[] = [];
    let call = 0;
    const tracker = new StatusTracker(
      async () => sequence[Math.min(call++, sequence.length - 1)],
      { record: (e: StatusEvent) => events.push(e) },
      () => Date.parse('2026-10-03T12:00:00.000Z'),
    );
    return { tracker, events };
  }

  it('records the initial state of every station and the site', async () => {
    const { tracker, events } = setup([[health('a', 'live'), health('b', 'source-down', false)]]);
    await tracker.refresh();

    expect(events).toEqual([
      { ts: '2026-10-03T12:00:00.000Z', station: 'a', from: null, to: 'live', upstreamReachable: null },
      { ts: '2026-10-03T12:00:00.000Z', station: 'b', from: null, to: 'source-down', upstreamReachable: false },
      { ts: '2026-10-03T12:00:00.000Z', station: '*', from: null, to: 'degraded', upstreamReachable: null },
    ]);
  });

  it('records only transitions on later refreshes', async () => {
    const { tracker, events } = setup([
      [health('a', 'live'), health('b', 'live')],
      [health('a', 'live'), health('b', 'live')],
      [health('a', 'live'), health('b', 'error', true)],
    ]);
    await tracker.refresh();
    events.length = 0;

    await tracker.refresh();
    expect(events).toEqual([]);

    await tracker.refresh();
    expect(events.map((e) => [e.station, e.from, e.to])).toEqual([
      ['b', 'live', 'error'],
      ['*', 'ok', 'degraded'],
    ]);
  });

  it('exposes the latest snapshot', async () => {
    const { tracker } = setup([[health('a', 'live')]]);
    expect(tracker.latest()).toBeNull();
    await tracker.refresh();
    expect(tracker.latest()?.status).toBe('ok');
  });

  it('keeps tracking when recording to history fails', async () => {
    const tracker = new StatusTracker(
      async () => [health('a', 'live')],
      { record: () => { throw new Error('disk full'); } },
    );
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(tracker.refresh()).resolves.toBeDefined();
    spy.mockRestore();
  });
});
