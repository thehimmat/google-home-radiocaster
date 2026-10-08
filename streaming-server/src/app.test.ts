import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { createApp, readMediaSequence, StationMap } from './app';
import { QualityReport } from './quality-poller';
import { UpstreamMonitor } from './upstream-monitor';
import { StatusEvent } from './status-history';
import { AirState } from './station-supervisor';

const FIXTURE_ROOT = path.join('/tmp', 'hls-test-' + process.pid);
const STATIONS: StationMap = {
  'test-station': { url: 'https://example.com/stream' },
};

const FIXTURE_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:4',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXTINF:4.0,',
  'seg00000.ts',
  '#EXTINF:4.0,',
  'seg00001.ts',
  '',
].join('\n');

beforeAll(() => {
  const dir = path.join(FIXTURE_ROOT, 'test-station');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stream.m3u8'), FIXTURE_PLAYLIST);
  fs.writeFileSync(path.join(dir, 'seg00000.ts'), Buffer.alloc(512));
  fs.writeFileSync(path.join(dir, 'seg00001.ts'), Buffer.alloc(512));
});

afterAll(() => {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

const app = createApp(STATIONS, FIXTURE_ROOT);

describe('GET /stations', () => {
  // Own app instance: the shared fixture has exactly one station and /health
  // assertions depend on that.
  const STATIONS_WITH_META: StationMap = {
    'golden-temple': {
      url: 'https://example.com/upstream',
      title: 'Golden Temple Radio',
      subtitle: 'Amritsar',
      artworkUrl: 'https://example.com/art.jpg',
    },
    'bare-station': { url: 'https://example.com/other' },
  };
  const metaApp = createApp(STATIONS_WITH_META, FIXTURE_ROOT);

  it('lists every station with metadata and client paths', async () => {
    const res = await request(metaApp).get('/stations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        slug: 'golden-temple',
        title: 'Golden Temple Radio',
        subtitle: 'Amritsar',
        artworkUrl: 'https://example.com/art.jpg',
        hlsPath: '/golden-temple',
        streamPath: '/golden-temple/stream',
      },
      {
        slug: 'bare-station',
        title: 'bare-station',
        subtitle: null,
        artworkUrl: null,
        hlsPath: '/bare-station',
        streamPath: '/bare-station/stream',
      },
    ]);
  });

  it('resolves artwork served from public/ to an absolute URL on this host', async () => {
    // The web player and Cast devices load artwork from another origin, so a
    // root-relative path must come back absolute.
    const localArtApp = createApp(
      { 'san-jose': { url: 'https://example.com/upstream', artworkUrl: '/artwork/san-jose.jpg' } },
      FIXTURE_ROOT,
    );
    const res = await request(localArtApp)
      .get('/stations')
      .set('Host', 'stream.example.com')
      .set('X-Forwarded-Proto', 'https');
    expect(res.body[0].artworkUrl).toBe('https://stream.example.com/artwork/san-jose.jpg');
  });

  it('serves the bundled station artwork', async () => {
    for (const file of ['san-jose.jpg', 'hazur-sahib.jpg']) {
      const res = await request(app).get(`/artwork/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
    }
  });

  it('returns CORS header so the web player can fetch it cross-origin', async () => {
    const res = await request(metaApp).get('/stations');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('is not shadowed by the station routes', async () => {
    // "stations" must never be treated as a station slug.
    const res = await request(metaApp).head('/stations');
    expect(res.status).toBe(200);
  });
});

describe('GET /health', () => {
  it('returns 200 with station list', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.stations).toHaveLength(1);
    expect(res.body.stations[0].name).toBe('test-station');
  });

  it('returns CORS header so the web player can poll it', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('reports a live station when segments are fresh', async () => {
    const res = await request(app).get('/health');
    expect(res.body.stations[0].status).toBe('live');
  });

  it('includes the latest audio-quality report per station when a poller is wired in', async () => {
    const report: QualityReport = {
      quality: 'choppy', cause: 'source', sourceRatio: 0.55, pipelineRatio: 0.6, checkedAt: '2026-10-03T22:00:00.000Z',
    };
    const qualityApp = createApp(STATIONS, FIXTURE_ROOT, undefined, undefined, undefined, undefined, undefined, {
      latest: (name) => (name === 'test-station' ? report : undefined),
    });
    const res = await request(qualityApp).get('/health');
    expect(res.body.stations[0].quality).toEqual(report);
    // Quality is informational: a choppy station is still live and doesn't page.
    expect(res.body.stations[0].status).toBe('live');
    expect(res.status).toBe(200);
  });

  it('reports quality as null for a station not sampled yet', async () => {
    const qualityApp = createApp(STATIONS, FIXTURE_ROOT, undefined, undefined, undefined, undefined, undefined, {
      latest: () => undefined,
    });
    const res = await request(qualityApp).get('/health');
    expect(res.body.stations[0].quality).toBeNull();
  });
});

describe('readMediaSequence', () => {
  it('reads EXT-X-MEDIA-SEQUENCE from the station playlist', () => {
    expect(readMediaSequence(FIXTURE_ROOT, 'test-station')).toBe(0);
  });

  it('is null when there is no playlist', () => {
    expect(readMediaSequence(FIXTURE_ROOT, 'missing')).toBeNull();
  });
});

describe('GET /health — paging rule', () => {
  // A station with no playlist on disk is always stale. 'test-station' (shared
  // fixture) is always live. /health pages (503) only when nothing is live; a
  // single dead station is labelled per-station but keeps the site at 200.
  const LIVE_AND_STALE: StationMap = {
    'test-station': { url: 'https://example.com/stream' },
    'ghost-station': { url: 'https://source.example/live' },
  };
  const STALE_ONLY: StationMap = { 'ghost-station': { url: 'https://source.example/live' } };

  it('stays 200 (degraded) when one station fails on our side but others are live', async () => {
    const monitor = new UpstreamMonitor(LIVE_AND_STALE, async () => true);
    const mixedApp = createApp(LIVE_AND_STALE, FIXTURE_ROOT, undefined, undefined, undefined, monitor);

    const res = await request(mixedApp).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.stations.find((s: { name: string }) => s.name === 'ghost-station').status).toBe('error');
  });

  it('labels a station source-down when its upstream is unreachable', async () => {
    const monitor = new UpstreamMonitor(LIVE_AND_STALE, async () => false);
    const mixedApp = createApp(LIVE_AND_STALE, FIXTURE_ROOT, undefined, undefined, undefined, monitor);

    const res = await request(mixedApp).get('/health');
    expect(res.status).toBe(200);
    const ghost = res.body.stations.find((s: { name: string }) => s.name === 'ghost-station');
    expect(ghost.status).toBe('source-down');
    expect(ghost.upstreamReachable).toBe(false);
  });

  it('returns 503 (down) when no station is live', async () => {
    const monitor = new UpstreamMonitor(STALE_ONLY, async () => true);
    const staleApp = createApp(STALE_ONLY, FIXTURE_ROOT, undefined, undefined, undefined, monitor);

    const res = await request(staleApp).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('down');
    expect(res.body.stations[0].status).toBe('error');
  });

  it('returns 503 when nothing is live even if every source looks unreachable', async () => {
    const monitor = new UpstreamMonitor(STALE_ONLY, async () => false);
    const staleApp = createApp(STALE_ONLY, FIXTURE_ROOT, undefined, undefined, undefined, monitor);

    const res = await request(staleApp).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.stations[0].status).toBe('source-down');
  });

  it('fails loud (error) for a stale station when no monitor is available', async () => {
    const staleApp = createApp(STALE_ONLY, FIXTURE_ROOT);
    const res = await request(staleApp).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.stations[0].status).toBe('error');
  });
});

describe('GET /history', () => {
  const events: StatusEvent[] = [
    { ts: '2026-10-01T00:00:00.000Z', station: 'a', from: null, to: 'live', upstreamReachable: null },
    { ts: '2026-10-02T00:00:00.000Z', station: 'b', from: 'live', to: 'error', upstreamReachable: true },
  ];
  let lastQuery: unknown;
  const history = {
    read: (q: unknown) => { lastQuery = q; return events; },
  };
  const historyApp = createApp(STATIONS, FIXTURE_ROOT, undefined, undefined, undefined, undefined, history);

  it('returns recorded status events with CORS', async () => {
    const res = await request(historyApp).get('/history');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(events);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('passes station, since and limit through to the store', async () => {
    await request(historyApp).get('/history?station=b&since=2026-10-02T00:00:00Z&limit=10');
    expect(lastQuery).toEqual({ station: 'b', since: Date.parse('2026-10-02T00:00:00Z'), limit: 10 });
  });

  it('rejects an unparseable since', async () => {
    const res = await request(historyApp).get('/history?since=yesterday');
    expect(res.status).toBe(400);
  });

  it('is 404 when history is not configured', async () => {
    const res = await request(app).get('/history');
    expect(res.status).toBe(404);
  });
});

describe('HEAD /:station', () => {
  it('returns 200 with application/x-mpegURL for valid station', async () => {
    const res = await request(app).head('/test-station');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-mpegURL');
  });

  it('returns 404 for unknown station', async () => {
    const res = await request(app).head('/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('GET /:station (playlist)', () => {
  it('returns 404 for unknown station', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('rewrites bare segment filenames to absolute URLs', async () => {
    const res = await request(app).get('/test-station');
    expect(res.status).toBe(200);
    // Express lowercases content-type on GET responses.
    expect(res.headers['content-type'].toLowerCase()).toContain('application/x-mpegurl');
    // Bare filenames must be gone.
    expect(res.text).not.toMatch(/^seg\d+\.ts$/m);
    // Each segment line must be an absolute URL containing the station path.
    const segLines = res.text.split('\n').filter((l) => l.includes('.ts'));
    expect(segLines.length).toBeGreaterThan(0);
    for (const line of segLines) {
      expect(line).toMatch(/^https?:\/\/.+\/test-station\/seg\d+\.ts$/);
    }
  });

  it('returns no-cache headers', async () => {
    const res = await request(app).get('/test-station');
    expect(res.headers['cache-control']).toContain('no-cache');
  });

  it('returns CORS header', async () => {
    const res = await request(app).get('/test-station');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('GET /:station/:file (segments)', () => {
  it('serves a .ts segment with video/MP2T content-type', async () => {
    const res = await request(app).get('/test-station/seg00000.ts');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('video/MP2T');
  });

  it('returns 404 for non-.ts files', async () => {
    const res = await request(app).get('/test-station/seg00000.mp4');
    expect(res.status).toBe(404);
  });

  it('returns 404 for missing segment', async () => {
    const res = await request(app).get('/test-station/seg99999.ts');
    expect(res.status).toBe(404);
  });

  it('returns 404 for segment on unknown station', async () => {
    const res = await request(app).get('/does-not-exist/seg00000.ts');
    expect(res.status).toBe(404);
  });
});

describe('off-air and dormant stations (StationSupervisor)', () => {
  // 'test-station' has a fresh playlist (live); the others have none.
  const MIXED: StationMap = {
    'test-station': { url: 'https://example.com/stream', title: 'Live One' },
    'scheduled': { url: 'https://source.example/scheduled', title: 'Scheduled' },
    'long-dead': { url: 'https://source.example/dead', title: 'Long Dead' },
  };
  const airStates: Record<string, AirState> = { 'test-station': 'live', scheduled: 'off-air', 'long-dead': 'dormant' };
  const probe = jest.fn(async () => true);
  const monitor = new UpstreamMonitor(MIXED, probe);
  const airApp = createApp(
    MIXED, FIXTURE_ROOT, undefined, undefined, undefined, monitor, undefined, undefined,
    (station) => airStates[station],
  );

  it('/stations hides dormant stations but keeps off-air ones', async () => {
    const res = await request(airApp).get('/stations');
    expect(res.body.map((s: { slug: string }) => s.slug)).toEqual(['test-station', 'scheduled']);
  });

  it('/health reports off-air (without probing) and stays 200 while something is live', async () => {
    probe.mockClear();
    const res = await request(airApp).get('/health');
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.stations.map((s: { name: string; status: string }) => [s.name, s.status]));
    expect(byName).toEqual({ 'test-station': 'live', scheduled: 'off-air', 'long-dead': 'off-air' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('/health is ok, not degraded, when every on-air station is live', async () => {
    const res = await request(airApp).get('/health');
    expect(res.body.status).toBe('ok');
  });

  it('the playlist answers 503 right away for an off-air station', async () => {
    const res = await request(airApp).get('/scheduled');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/off air/i);
  });

  it('the Cast stream answers 503 for an off-air station instead of spawning FFmpeg', async () => {
    const res = await request(airApp).get('/long-dead/stream');
    expect(res.status).toBe(503);
  });
});
