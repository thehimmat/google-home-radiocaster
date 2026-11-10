import http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { createApp } from './app';
import { NowPlayingRelay, Upstream } from './now-playing';

const showing = (line: number, updatedAt = 't') => ({
  station: 'golden-temple',
  state: 'showing',
  shabad: { id: '3JP', page: 713 },
  line: { index: line, text: `line ${line}` },
  updatedAt,
});

/** An upstream whose answer the test changes; counts calls. */
interface Fake {
  answer: { status: number; body?: unknown } | Error;
  calls: number;
  fetch: Upstream;
}

function fakeUpstream(initial: Fake['answer']): Fake {
  const u: Fake = {
    answer: initial,
    calls: 0,
    fetch: async () => {
      u.calls++;
      if (u.answer instanceof Error) throw u.answer;
      return u.answer;
    },
  };
  return u;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('NowPlayingRelay', () => {
  it('returns what the lyrics service says, and caches it for pollMs', async () => {
    const up = fakeUpstream({ status: 200, body: showing(1) });
    const relay = new NowPlayingRelay(up.fetch, { pollMs: 50 });
    expect(await relay.get('golden-temple')).toEqual({ status: 200, body: showing(1) });
    await relay.get('golden-temple');
    expect(up.calls).toBe(1);
    await wait(60);
    await relay.get('golden-temple');
    expect(up.calls).toBe(2);
  });

  it('answers 503 when the lyrics service is unreachable', async () => {
    const relay = new NowPlayingRelay(fakeUpstream(new Error('ECONNREFUSED')).fetch, { pollMs: 50 });
    expect((await relay.get('golden-temple')).status).toBe(503);
  });

  it('pushes to subscribers only when what is shown changes, not on every updatedAt', async () => {
    const up = fakeUpstream({ status: 200, body: showing(1, 'a') });
    const relay = new NowPlayingRelay(up.fetch, { pollMs: 10 });
    const seen: unknown[] = [];
    const stop = relay.subscribe('golden-temple', (d) => seen.push(d));
    await wait(40);
    up.answer = { status: 200, body: showing(1, 'b') };
    await wait(40);
    up.answer = { status: 200, body: showing(2, 'c') };
    await wait(40);
    stop();
    expect(seen).toEqual([showing(1, 'a'), showing(2, 'c')]);
  });

  it('polls only while someone is subscribed, with one poller shared by all subscribers', async () => {
    const up = fakeUpstream({ status: 200, body: showing(1) });
    const relay = new NowPlayingRelay(up.fetch, { pollMs: 10 });
    const a = relay.subscribe('golden-temple', () => undefined);
    const b = relay.subscribe('golden-temple', () => undefined);
    await wait(55);
    const both = up.calls;
    expect(both).toBeGreaterThanOrEqual(3);
    expect(both).toBeLessThanOrEqual(7); // one poller, not two
    a();
    b();
    await wait(40);
    const after = up.calls;
    await wait(40);
    expect(up.calls).toBe(after);
  });

  it('tells subscribers when the lyrics service goes away', async () => {
    const up = fakeUpstream({ status: 200, body: showing(1) });
    const relay = new NowPlayingRelay(up.fetch, { pollMs: 10 });
    const seen: unknown[] = [];
    const stop = relay.subscribe('golden-temple', (d) => seen.push(d));
    await wait(30);
    up.answer = new Error('down');
    await wait(30);
    stop();
    expect(seen[seen.length - 1]).toEqual({ station: 'golden-temple', state: 'unavailable' });
  });
});

describe('/now-playing routes', () => {
  const stations = { 'golden-temple': { url: 'https://example.com/live' } };
  const appWith = (relay?: NowPlayingRelay) =>
    createApp(stations, '/tmp/np-test', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, relay);

  it('is 404 when the server has no lyrics service (Fly)', async () => {
    await request(appWith()).get('/now-playing/golden-temple').expect(404);
  });

  it('relays the JSON, cross-origin', async () => {
    const relay = new NowPlayingRelay(fakeUpstream({ status: 200, body: showing(3) }).fetch);
    const res = await request(appWith(relay)).get('/now-playing/golden-temple').expect(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.body).toEqual(showing(3));
  });

  it('is 404 for a station that does not exist', async () => {
    const relay = new NowPlayingRelay(fakeUpstream({ status: 200, body: showing(3) }).fetch);
    await request(appWith(relay)).get('/now-playing/nowhere').expect(404);
  });

  it('streams changes as server-sent events', async () => {
    const up = fakeUpstream({ status: 200, body: showing(1) });
    const relay = new NowPlayingRelay(up.fetch, { pollMs: 10 });
    const server = appWith(relay).listen(0);
    const { port } = server.address() as AddressInfo;
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/now-playing/golden-temple/events`, (res) => {
          expect(res.headers['content-type']).toMatch(/text\/event-stream/);
          expect(res.headers['access-control-allow-origin']).toBe('*');
          let body = '';
          res.on('data', (c) => {
            body += c;
            if (body.includes('line 1')) up.answer = { status: 200, body: showing(2) };
            if (body.includes('line 2')) { req.destroy(); resolve(body); }
          });
        });
        req.on('error', reject);
      });
      const events = text.split('\n\n').filter((e) => e.startsWith('data: '));
      expect(events.map((e) => JSON.parse(e.slice(6)).line.index)).toEqual([1, 2]);
      await wait(30);
      const calls = up.calls;
      await wait(30);
      expect(up.calls).toBe(calls); // the client left, so polling stopped
    } finally {
      server.close();
    }
  });
});
