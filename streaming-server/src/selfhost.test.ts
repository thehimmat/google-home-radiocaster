import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';

// The scripts for kosh-db (selfhost/) are plain sh so they run on a fresh Ubuntu box with nothing
// but Docker. These run them on any POSIX host: deploy.sh in dry-run mode, smoke.sh against a
// stand-in for the streaming server.

const selfhost = path.resolve(__dirname, '..', 'selfhost');

function sh(script: string, args: string[], env: NodeJS.ProcessEnv = {}, cwd = selfhost) {
  return new Promise<{ status: number | null; out: string }>((resolve) => {
    // Async spawn: smoke.sh calls back into the fake server running in this process.
    const proc = spawn('/bin/sh', [script, ...args], { cwd, env: { ...process.env, ...env } });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (out += d));
    proc.on('close', (status) => resolve({ status, out }));
  });
}

describe('deploy.sh', () => {
  const deploy = (target: string | undefined, env: NodeJS.ProcessEnv = {}) =>
    spawnSync('/bin/sh', [path.join(selfhost, 'scripts/deploy.sh'), ...(target ? [target] : [])], {
      env: { ...process.env, RADIO_DEPLOY_DRY_RUN: '1', ...env },
      encoding: 'utf8',
    });

  it('accepts only radio or config, from the SSH forced command or an argument', () => {
    expect(deploy(undefined).status).toBe(2);
    expect(deploy('rm -rf /').status).toBe(2);
    expect(deploy('radio').stdout).toContain('deploy radio');
    expect(deploy(undefined, { SSH_ORIGINAL_COMMAND: 'config' }).stdout).toContain('deploy config');
  });
});

describe('docker-compose.yml', () => {
  const compose = fs.readFileSync(path.join(selfhost, 'docker-compose.yml'), 'utf8');

  it("names its project, so Compose doesn't merge it with kosh's stack in a folder also called selfhost", () => {
    expect(compose).toMatch(/^name: radio$/m);
  });

  it("leaves ports 80 and 443 to kosh's gateway and joins only the network they share", () => {
    expect(compose).not.toMatch(/^ {2}gateway:/m);
    expect(compose).toMatch(/^networks:\n(?: *#.*\n)* {2}radio-edge:\n {4}external: true$/m);
    expect(compose).toMatch(/networks: \[radio-edge\]/);
  });

  it('keeps the host port on localhost only', () => {
    expect(compose).toContain('"127.0.0.1:3001:3001"');
  });

  describe('lyrics follower (lyrics/)', () => {
    const lyrics = compose.slice(compose.indexOf('\n  lyrics:'), compose.indexOf('\nnetworks:'));

    it('is opt-in (COMPOSE_PROFILES=lyrics in .env), so deploys work before its image exists', () => {
      expect(lyrics).toMatch(/^ {4}profiles: \[lyrics\]$/m);
    });

    it('reads our own stream over the shared network, with its port on localhost only', () => {
      expect(lyrics).toContain('RADIO_URL: http://radio:3001');
      expect(lyrics).toContain('"127.0.0.1:3002:3002"');
      expect(lyrics).toMatch(/networks: \[radio-edge\]/);
    });

    it("is capped so speech recognition can't starve the radio or kosh's apps, and never sees .env's secrets", () => {
      expect(lyrics).toMatch(/^ {4}cpus: /m);
      expect(lyrics).toMatch(/^ {4}mem_limit: /m);
      expect(lyrics).not.toContain('env_file');
    });
  });
});

describe('deploy.sh pulls every enabled service', () => {
  it('pulls without naming one, so the lyrics image updates too once its profile is on', () => {
    const script = fs.readFileSync(path.join(selfhost, 'scripts/deploy.sh'), 'utf8');
    expect(script).toMatch(/docker compose pull -q$/m);
  });
});

describe('smoke.sh', () => {
  let server: http.Server;
  let base: string;
  let streamBody: Buffer;
  let healthStatus: number;

  beforeEach(async () => {
    // Two ADTS frame headers (syncword 0xFFF, MPEG-4, no CRC) with filler between them.
    streamBody = Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80]), Buffer.alloc(200, 0x11), Buffer.from([0xff, 0xf1])]);
    healthStatus = 200;
    server = http.createServer((req, res) => {
      if (req.url === '/stations') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify([{ slug: 'golden-temple', streamPath: '/golden-temple/stream' }]));
      } else if (req.url === '/health') {
        res.statusCode = healthStatus;
        res.end(JSON.stringify({ status: healthStatus === 200 ? 'ok' : 'down' }));
      } else if (req.url === '/golden-temple/stream') {
        res.setHeader('Content-Type', 'audio/aac');
        res.write(streamBody); // and never end, like the real stream
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const smoke = (...args: string[]) => sh('scripts/smoke.sh', [base, ...args], { SMOKE_STREAM_SECONDS: '2' });

  it('passes when the station is listed and its stream carries AAC frames', async () => {
    const r = await smoke();
    expect(r.out).toContain('ok');
    expect(r.status).toBe(0);
  });

  it('still passes when /health is 503 (every source off air is not a deploy failure)', async () => {
    healthStatus = 503;
    const r = await smoke();
    expect(r.out).toMatch(/health.*503/);
    expect(r.status).toBe(0);
  });

  it('fails when the stream has no AAC frames', async () => {
    streamBody = Buffer.alloc(300, 0x11);
    const r = await smoke();
    expect(r.out).toMatch(/no AAC/);
    expect(r.status).not.toBe(0);
  });

  it('fails when the station is not listed', async () => {
    const r = await smoke('fremont');
    expect(r.out).toMatch(/fremont/);
    expect(r.status).not.toBe(0);
  });
});
