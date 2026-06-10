import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { AddressInfo } from 'net';
import { probeStream } from './cast';

// probeStream is the logic that has burned us before: a wrong fallback here
// sends the wrong content-type to the Cast device, which rejects the stream
// with an opaque "Load failed". These tests pin down every branch against
// real local HTTP servers. The short timeoutMs keeps the suite fast.

const servers: Array<http.Server | https.Server> = [];

function listen(server: http.Server | https.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers.length = 0;
});

describe('probeStream', () => {
  it('returns the detected content-type for audio streams', async () => {
    const port = await listen(http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/aac' });
      res.end();
    }));

    const info = await probeStream(`http://127.0.0.1:${port}/stream`, 5, false, 1000);
    expect(info).toEqual({ url: `http://127.0.0.1:${port}/stream`, contentType: 'audio/aac' });
  });

  it('accepts HLS playlist content-types as-is', async () => {
    const port = await listen(http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-mpegURL; charset=utf-8' });
      res.end();
    }));

    const info = await probeStream(`http://127.0.0.1:${port}/`, 5, false, 1000);
    expect(info.contentType).toBe('application/x-mpegURL');
  });

  it('falls back to audio/mpeg when the server reports a non-audio type', async () => {
    const port = await listen(http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end();
    }));

    const info = await probeStream(`http://127.0.0.1:${port}/`, 5, false, 1000);
    expect(info.contentType).toBe('audio/mpeg');
  });

  it('follows redirects and reports the final URL', async () => {
    const port = await listen(http.createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/final' });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/ogg' });
        res.end();
      }
    }));

    const info = await probeStream(`http://127.0.0.1:${port}/start`, 5, false, 1000);
    expect(info).toEqual({ url: `http://127.0.0.1:${port}/final`, contentType: 'application/ogg' });
  });

  it('gives up after maxHops redirects and falls back', async () => {
    const port = await listen(http.createServer((_req, res) => {
      res.writeHead(302, { Location: '/loop' });
      res.end();
    }));

    const info = await probeStream(`http://127.0.0.1:${port}/loop`, 3, false, 1000);
    expect(info.contentType).toBe('audio/mpeg');
  });

  it('falls back to audio/mpeg when the probe times out', async () => {
    // Server that accepts the connection but never responds.
    const port = await listen(http.createServer(() => { /* hold the request open */ }));

    const info = await probeStream(`http://127.0.0.1:${port}/`, 5, false, 300);
    expect(info.contentType).toBe('audio/mpeg');
  });

  it('falls back to audio/mpeg when the connection is refused', async () => {
    // Grab a free port, then close the server so nothing is listening on it.
    const probe = http.createServer();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as AddressInfo).port));
    });
    await new Promise((r) => probe.close(r));

    const info = await probeStream(`http://127.0.0.1:${port}/`, 5, false, 1000);
    expect(info.contentType).toBe('audio/mpeg');
  });

  it('retries without TLS verification on a self-signed cert (SGPC case)', async () => {
    const fixtures = path.join(__dirname, 'test-fixtures');
    const port = await listen(https.createServer(
      {
        key: fs.readFileSync(path.join(fixtures, 'self-signed.key')),
        cert: fs.readFileSync(path.join(fixtures, 'self-signed.crt')),
      },
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'audio/aac' });
        res.end();
      },
    ));

    const info = await probeStream(`https://localhost:${port}/`, 5, false, 1000);
    expect(info.contentType).toBe('audio/aac');
  });
});
