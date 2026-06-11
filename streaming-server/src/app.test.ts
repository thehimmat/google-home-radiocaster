import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { createApp, StationMap } from './app';

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
