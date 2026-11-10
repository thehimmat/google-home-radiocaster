import { AddressInfo } from 'net';
import { Server } from 'http';
import { createServer, NowPlaying } from './app';

const playing: NowPlaying = {
  station: 'golden-temple', state: 'showing', reason: 'show', committed: true, since: 1069,
  updatedAt: '2026-11-10T02:00:00.000Z',
  shabad: { id: 'ABC1', source: 'Sri Guru Granth Sahib', section: 'Raag Kaydaaraa', page: 1120 },
  line: { index: 1, text: 'ਕਰਹੁ ਕ੍ਰਿਪਾ ਗੋਪਾਲ ਗੋਬਿਦੇ ਅਪਨਾ ਨਾਮੁ ਜਪਾਵਹੁ ॥ ਰਹਾਉ ॥' },
  lines: ['ਹਰਿ ਹਰਿ ਹਰਿ ਗੁਨ ਗਾਵਹੁ ॥', 'ਕਰਹੁ ਕ੍ਰਿਪਾ ਗੋਪਾਲ ਗੋਬਿਦੇ ਅਪਨਾ ਨਾਮੁ ਜਪਾਵਹੁ ॥ ਰਹਾਉ ॥'],
};

describe('lyrics HTTP server', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer({
      nowPlaying: (s) => (s === 'golden-temple' ? playing : undefined),
      health: () => ({ stations: { 'golden-temple': { streamSec: 60, lagSec: 0.4 } } }),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it('serves what to display for a station, readable from the web player', async () => {
    const res = await fetch(`${base}/now-playing/golden-temple`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual(playing);
  });

  it('is 404 for a station it does not follow', async () => {
    expect((await fetch(`${base}/now-playing/fremont`)).status).toBe(404);
  });

  it('reports health', async () => {
    const res = await fetch(`${base}/health`);
    expect(await res.json()).toMatchObject({ stations: { 'golden-temple': { streamSec: 60 } } });
  });
});
