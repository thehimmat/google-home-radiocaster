import { QualityPoller, pipelineRatio } from './quality-poller';
import { SourceSample } from './stream-quality';
import { StatusEvent } from './status-history';

describe('pipelineRatio', () => {
  it('is media seconds produced per wall second between two playlist readings', () => {
    // 9 segments of 6s in 90s → 0.6x
    expect(pipelineRatio({ at: 0, sequence: 100 }, { at: 90_000, sequence: 109 }, 6)).toBeCloseTo(0.6);
  });

  it('is null without a previous reading or a current one', () => {
    expect(pipelineRatio(undefined, { at: 0, sequence: 1 }, 6)).toBeNull();
    expect(pipelineRatio({ at: 0, sequence: 1 }, null, 6)).toBeNull();
  });

  it('is null across an FFmpeg restart, which jumps the sequence forward', () => {
    expect(pipelineRatio({ at: 0, sequence: 100 }, { at: 60_000, sequence: 140 }, 6)).toBeNull();
    expect(pipelineRatio({ at: 0, sequence: 100 }, { at: 60_000, sequence: 90 }, 6)).toBeNull();
  });
});

describe('QualityPoller', () => {
  const healthy: SourceSample = { gotAudio: true, wallSeconds: 20, mediaSeconds: 20, silences: [] };
  const choppy: SourceSample = { gotAudio: true, wallSeconds: 20, mediaSeconds: 11, silences: [] };

  function setup(samples: SourceSample[], sequences: (number | null)[] = []) {
    const events: StatusEvent[] = [];
    let clock = Date.parse('2026-10-03T22:00:00.000Z');
    let s = 0;
    let q = 0;
    const poller = new QualityPoller({
      stations: { 'golden-temple': { url: 'https://src' } },
      sample: async () => samples[Math.min(s++, samples.length - 1)],
      readSequence: () => sequences[Math.min(q++, sequences.length - 1)] ?? null,
      recorder: { record: (e) => events.push(e) },
      now: () => clock,
      segmentSeconds: 6,
    });
    const advance = (ms: number) => { clock += ms; };
    return { poller, events, advance };
  }

  it('reports the latest classification, cause and ratios per station', async () => {
    const { poller, advance } = setup([choppy, choppy], [100, 109]);
    await poller.poll('golden-temple');
    advance(90_000);
    await poller.poll('golden-temple');

    expect(poller.latest('golden-temple')).toMatchObject({
      quality: 'choppy',
      cause: 'source',
      sourceRatio: 0.55,
      pipelineRatio: 0.6,
      checkedAt: '2026-10-03T22:01:30.000Z',
    });
  });

  it('logs quality transitions to history as kind "quality", only on change', async () => {
    const { poller, events } = setup([healthy, healthy, choppy, healthy]);
    for (let i = 0; i < 4; i++) await poller.poll('golden-temple');

    expect(events.map((e) => [e.from, e.to])).toEqual([
      [null, 'healthy'],
      ['healthy', 'choppy'],
      ['choppy', 'healthy'],
    ]);
    expect(events[1]).toMatchObject({ station: 'golden-temple', kind: 'quality', cause: 'source', upstreamReachable: true });
  });

  it('marks an unreachable source as upstreamReachable=false', async () => {
    const { poller, events } = setup([{ gotAudio: false, wallSeconds: 20, mediaSeconds: 0, silences: [] }]);
    await poller.poll('golden-temple');
    expect(events[0]).toMatchObject({ to: 'down', upstreamReachable: false });
  });

  it('returns undefined for a station that has not been sampled yet', () => {
    const { poller } = setup([healthy]);
    expect(poller.latest('golden-temple')).toBeUndefined();
  });

  it('keeps going if a sample throws', async () => {
    const events: StatusEvent[] = [];
    const poller = new QualityPoller({
      stations: { a: { url: 'u' } },
      sample: async () => { throw new Error('spawn failed'); },
      readSequence: () => null,
      recorder: { record: (e) => events.push(e) },
    });
    await expect(poller.poll('a')).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });
});

describe('QualityPoller with off-air stations', () => {
  it('does not sample a station that is not live, so off-air sources cost no FFmpeg', async () => {
    const sample = jest.fn(async (): Promise<SourceSample> => ({ gotAudio: true, wallSeconds: 20, mediaSeconds: 20, silences: [] }));
    const poller = new QualityPoller({
      stations: { live: { url: 'https://a' }, quiet: { url: 'https://b' } },
      sample,
      readSequence: () => null,
      recorder: { record: () => undefined },
      isActive: (station) => station === 'live',
    });
    await poller.poll('quiet');
    await poller.poll('live');
    expect(sample).toHaveBeenCalledTimes(1);
    expect(sample).toHaveBeenCalledWith('https://a');
  });
});

describe('QualityPoller listener check', () => {
  const healthy: SourceSample = { gotAudio: true, wallSeconds: 20, mediaSeconds: 20, silences: [] };
  const gappy: SourceSample = { gotAudio: true, wallSeconds: 20, mediaSeconds: 20, silences: [0.5, 0.8, 1.2] };

  function setup(samples: Record<string, SourceSample[] | Error>, listenerUrl?: (s: string) => string | null) {
    const events: StatusEvent[] = [];
    const calls: string[] = [];
    const counts: Record<string, number> = {};
    let inFlight = 0;
    let maxInFlight = 0;
    const poller = new QualityPoller({
      stations: { 'golden-temple': { url: 'https://src' } },
      sample: async (url) => {
        calls.push(url);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight--;
        const list = samples[url];
        if (list instanceof Error) throw list;
        const i = counts[url] = (counts[url] ?? -1) + 1;
        return list[Math.min(i, list.length - 1)];
      },
      readSequence: () => null,
      recorder: { record: (e) => events.push(e) },
      listenerUrl,
    });
    return { poller, events, calls, maxInFlight: () => maxInFlight };
  }

  const ours = (s: string) => `https://stream.example/${s}/stream`;

  it('samples the source and our public stream at the same time', async () => {
    const { poller, calls, maxInFlight } = setup({ 'https://src': [healthy], [ours('golden-temple')]: [healthy] }, ours);
    await poller.poll('golden-temple');
    expect(calls.sort()).toEqual(['https://src', 'https://stream.example/golden-temple/stream']);
    expect(maxInFlight()).toBe(2);
  });

  it('blames delivery when the source is clean but what a listener gets has gaps', async () => {
    const { poller, events } = setup({ 'https://src': [healthy], [ours('golden-temple')]: [gappy] }, ours);
    await poller.poll('golden-temple');
    expect(poller.latest('golden-temple')).toMatchObject({
      quality: 'healthy',
      listener: 'choppy',
      listenerRatio: 1,
      cause: 'delivery',
    });
    expect(events[0]).toMatchObject({ to: 'healthy', listener: 'choppy', cause: 'delivery' });
  });

  it('logs a change in what the listener hears even when the source stays the same', async () => {
    const { poller, events } = setup(
      { 'https://src': [healthy], [ours('golden-temple')]: [healthy, gappy, gappy] },
      ours,
    );
    for (let i = 0; i < 3; i++) await poller.poll('golden-temple');
    expect(events.map((e) => [e.to, e.listener])).toEqual([
      ['healthy', 'healthy'],
      ['healthy', 'choppy'],
    ]);
  });

  it('keeps the source result if the listener sample fails', async () => {
    const { poller } = setup({ 'https://src': [healthy], [ours('golden-temple')]: new Error('boom') }, ours);
    await poller.poll('golden-temple');
    expect(poller.latest('golden-temple')).toMatchObject({ quality: 'healthy', listener: null, cause: 'none' });
  });

  it('samples only the source when no listener URL is configured', async () => {
    const { poller, calls } = setup({ 'https://src': [healthy] });
    await poller.poll('golden-temple');
    expect(calls).toEqual(['https://src']);
    expect(poller.latest('golden-temple')).toMatchObject({ listener: null, listenerRatio: null });
  });
});
