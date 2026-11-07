import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

// The Oracle VM's scripts (selfhost/) are plain sh so they run on a fresh Ubuntu box with nothing
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
  let tmp: string;

  beforeEach(() => {
    // A copy of selfhost/, so enabling the Cloudflare site doesn't touch the repo.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-selfhost-'));
    fs.cpSync(selfhost, tmp, { recursive: true });
    fs.rmSync(path.join(tmp, 'sites-enabled'), { recursive: true, force: true });
    fs.rmSync(path.join(tmp, 'certs'), { recursive: true, force: true });
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const deploy = (target: string | undefined, env: NodeJS.ProcessEnv = {}) =>
    spawnSync('/bin/sh', [path.join(tmp, 'scripts/deploy.sh'), ...(target ? [target] : [])], {
      env: { ...process.env, RADIO_DEPLOY_DRY_RUN: '1', ...env },
      encoding: 'utf8',
    });

  it('accepts only radio or config, from the SSH forced command or an argument', () => {
    expect(deploy(undefined).status).toBe(2);
    expect(deploy('rm -rf /').status).toBe(2);
    expect(deploy('radio').stdout).toContain('deploy radio');
    expect(deploy(undefined, { SSH_ORIGINAL_COMMAND: 'config' }).stdout).toContain('deploy config');
  });

  it('serves stream.atthebunga.com only once the Cloudflare certificates are in place', () => {
    const enabled = path.join(tmp, 'sites-enabled/stream.caddy');
    expect(deploy('config').status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'sites-enabled'))).toBe(true);
    expect(fs.existsSync(enabled)).toBe(false);

    fs.mkdirSync(path.join(tmp, 'certs'));
    for (const f of ['origin.pem', 'origin.key', 'cloudflare-origin-pull-ca.pem']) {
      fs.writeFileSync(path.join(tmp, 'certs', f), 'x');
    }
    expect(deploy('config').status).toBe(0);
    expect(fs.readFileSync(enabled, 'utf8')).toContain('stream.atthebunga.com');
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
