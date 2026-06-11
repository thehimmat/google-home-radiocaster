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
  it('parses per-station liveness, including degraded (503) responses', async () => {
    stubFetch(
      {
        status: 'degraded',
        stations: [
          { name: 'live-one', processAlive: true, segmentFresh: true },
          { name: 'down-one', processAlive: true, segmentFresh: false },
        ],
      },
      false,
      503,
    );

    const health = await fetchHealth(BASE);
    expect(health.get('live-one')).toBe(true);
    expect(health.get('down-one')).toBe(false);
  });
});
