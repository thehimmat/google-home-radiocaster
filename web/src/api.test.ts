import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchHealth, fetchStations, toStation } from './api';

const BASE = 'https://stream.example.com';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown, ok = true, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })));
}

describe('toStation', () => {
  it('resolves server-relative paths against the stream base', () => {
    const station = toStation(
      {
        slug: 'golden-temple',
        title: 'Golden Temple Radio',
        subtitle: 'Amritsar',
        artworkUrl: 'https://example.com/art.jpg',
        hlsPath: '/golden-temple',
        streamPath: '/golden-temple/stream',
      },
      BASE,
    );

    expect(station.hlsUrl).toBe('https://stream.example.com/golden-temple');
    expect(station.streamUrl).toBe('https://stream.example.com/golden-temple/stream');
    expect(station.title).toBe('Golden Temple Radio');
  });
});

describe('fetchStations', () => {
  it('maps the /stations payload to resolved Station objects', async () => {
    stubFetch([
      {
        slug: 's1',
        title: 'One',
        subtitle: null,
        artworkUrl: null,
        hlsPath: '/s1',
        streamPath: '/s1/stream',
      },
    ]);

    const stations = await fetchStations(BASE);
    expect(stations).toHaveLength(1);
    expect(stations[0].streamUrl).toBe(`${BASE}/s1/stream`);
  });

  it('throws on a non-ok response', async () => {
    stubFetch({}, false, 503);
    await expect(fetchStations(BASE)).rejects.toThrow('503');
  });
});

describe('fetchHealth', () => {
  const station = (name: string, extra: Record<string, unknown>) => ({
    name, processAlive: true, segmentFresh: true, upstreamReachable: true, status: 'live', ...extra,
  });

  it('maps every station to a public badge, including on degraded (503) responses', async () => {
    stubFetch(
      {
        status: 'degraded',
        stations: [
          station('ok', { quality: { quality: 'healthy', cause: 'none' } }),
          station('quiet', { quality: { quality: 'silent', cause: 'source' } }),
          station('gappy', { quality: { quality: 'choppy', cause: 'source' } }),
          station('ours', { segmentFresh: false, status: 'error' }),
          station('theirs', { segmentFresh: false, upstreamReachable: false, status: 'source-down' }),
        ],
      },
      false,
      503,
    );

    const health = await fetchHealth(BASE);
    expect(Object.fromEntries(health)).toEqual({
      ok: 'healthy', quiet: 'silent', gappy: 'choppy', ours: 'down', theirs: 'down',
    });
  });

  it('never exposes who is at fault: our outage and the source\'s look the same', async () => {
    stubFetch({ status: 'degraded', stations: [
      station('ours', { status: 'error' }),
      station('theirs', { status: 'source-down' }),
      station('gappy-ours', { quality: { quality: 'healthy', cause: 'us' } }),
    ] }, true, 200);

    const health = await fetchHealth(BASE);
    expect(health.get('ours')).toBe(health.get('theirs'));
    expect(health.get('gappy-ours')).toBe('healthy');
  });

  it('is healthy for a live station not sampled yet (quality null or absent)', async () => {
    stubFetch({ status: 'ok', stations: [station('new', { quality: null }), station('old', {})] }, true, 200);

    const health = await fetchHealth(BASE);
    expect(health.get('new')).toBe('healthy');
    expect(health.get('old')).toBe('healthy');
  });

  it('is down when the source sample got no audio, even if segments are still fresh', async () => {
    stubFetch({ status: 'ok', stations: [station('x', { quality: { quality: 'down' } })] }, true, 200);
    expect((await fetchHealth(BASE)).get('x')).toBe('down');
  });

  it('falls back to down when a stale station reports no status field', async () => {
    stubFetch(
      { status: 'degraded', stations: [{ name: 'legacy', processAlive: true, segmentFresh: false }] },
      false,
      503,
    );

    const health = await fetchHealth(BASE);
    expect(health.get('legacy')).toBe('down');
  });
});
