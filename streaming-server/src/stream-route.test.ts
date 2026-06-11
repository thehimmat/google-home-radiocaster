import * as http from 'http';
import { AddressInfo } from 'net';
import { EventEmitter, PassThrough } from 'stream';
import { ChildProcess } from 'child_process';
import request from 'supertest';
import { createApp, StationMap, SpawnFn } from './app';
import { StationBroadcaster } from './broadcaster';
import { buildAdtsArgs } from './ffmpeg-args';

// The /:station/stream endpoint serves an infinite byte stream, so these tests
// use a real listening server + raw http client (supertest buffers until the
// response ends, which never happens here).

const STATIONS: StationMap = {
  'test-station': { url: 'https://example.com/stream' },
};

class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  pid = 4242;
  killed = false;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.emit('exit', null, signal ?? 'SIGTERM');
    return true;
  }
}

function makeApp(broadcasterOpts?: ConstructorParameters<typeof StationBroadcaster>[3]) {
  const spawned: { command: string; args: string[]; proc: FakeProc }[] = [];
  const fakeSpawn: SpawnFn = (command, args) => {
    const proc = new FakeProc();
    spawned.push({ command, args, proc });
    return proc as unknown as ChildProcess;
  };
  const broadcasters = new Map<string, StationBroadcaster>();
  if (broadcasterOpts) {
    broadcasters.set(
      'test-station',
      new StationBroadcaster('test-station', STATIONS['test-station'].url, fakeSpawn, broadcasterOpts),
    );
  }
  const app = createApp(STATIONS, '/tmp/unused-hls-root', undefined, fakeSpawn, broadcasters);
  return { app, spawned };
}

/** GET a path and resolve once response headers arrive (body still open). */
function getStreaming(port: number, path: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    http.get({ port, path }, resolve).on('error', reject);
  });
}

function firstChunk(res: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => res.once('data', resolve));
}

describe('GET /:station/stream', () => {
  it('returns 404 for unknown station without spawning ffmpeg', async () => {
    const { app, spawned } = makeApp();
    const res = await request(app).get('/does-not-exist/stream');
    expect(res.status).toBe(404);
    expect(spawned).toHaveLength(0);
  });

  it('streams ffmpeg stdout with audio/aac, no-cache, and CORS headers', async () => {
    const { app, spawned } = makeApp();
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await getStreaming(port, '/test-station/stream');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('audio/aac');
      expect(res.headers['cache-control']).toContain('no-cache');
      expect(res.headers['access-control-allow-origin']).toBe('*');

      expect(spawned).toHaveLength(1);
      expect(spawned[0].command).toBe('ffmpeg');
      // The exact args are the shared ADTS build — keeps the two FFmpeg paths in lockstep.
      expect(spawned[0].args).toEqual(buildAdtsArgs(STATIONS['test-station'].url));

      const chunkPromise = firstChunk(res);
      spawned[0].proc.stdout.write(Buffer.from('adts-bytes'));
      expect((await chunkPromise).toString()).toBe('adts-bytes');

      res.destroy();
    } finally {
      server.close();
    }
  });

  it('shares one ffmpeg process across concurrent listeners', async () => {
    const { app, spawned } = makeApp();
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;

    try {
      const resA = await getStreaming(port, '/test-station/stream');
      const resB = await getStreaming(port, '/test-station/stream');

      // The whole point of the broadcaster: second listener, still one process.
      expect(spawned).toHaveLength(1);

      const chunks = Promise.all([firstChunk(resA), firstChunk(resB)]);
      spawned[0].proc.stdout.write(Buffer.from('shared'));
      const [a, b] = await chunks;
      expect(a.toString()).toBe('shared');
      expect(b.toString()).toBe('shared');

      resA.destroy();
      resB.destroy();
    } finally {
      server.close();
    }
  });

  it('kills ffmpeg after the linger window once the last client disconnects', async () => {
    const { app, spawned } = makeApp({ lingerMs: 30 });
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await getStreaming(port, '/test-station/stream');
      expect(spawned).toHaveLength(1);

      res.destroy();
      await new Promise((r) => setTimeout(r, 100));
      expect(spawned[0].proc.killed).toBe(true);
    } finally {
      server.close();
    }
  });
});
