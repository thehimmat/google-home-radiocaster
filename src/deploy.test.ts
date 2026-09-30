import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The launchd deploy scripts are plain bash so they can run on a fresh Mac
// with nothing but Node installed. These tests exercise them on any POSIX
// host: the installer in render-only mode (no launchctl), and the agent
// wrapper with a stand-in for node.

const repoRoot = path.resolve(__dirname, '..');
const deployDir = path.join(repoRoot, 'deploy');
const label = 'com.atthebunga.radiocaster';

function run(script: string, args: string[], env: NodeJS.ProcessEnv) {
  // Absolute bash path so a test can clobber PATH without losing the shell.
  return spawnSync('/bin/bash', [path.join(deployDir, script), ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radiocaster-deploy-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A stand-in for node that records how it was invoked, so tests can assert
// the wrapper hands off to ts-node on src/index.ts. Executable, because both
// scripts refuse a node path they can't run.
function fakeNode(): string {
  const bin = path.join(tmp, 'fake-node');
  fs.writeFileSync(bin, `#!/bin/bash\necho "fake-node $*"\n`, { mode: 0o755 });
  return bin;
}

describe('install-agent.sh --render-only', () => {
  it('writes a plist with every placeholder substituted', () => {
    const node = fakeNode();
    const result = run('install-agent.sh', ['--render-only'], {
      RADIOCASTER_LAUNCH_AGENTS_DIR: tmp,
      RADIOCASTER_NODE: node,
    });
    expect(result.status).toBe(0);

    const plist = fs.readFileSync(path.join(tmp, `${label}.plist`), 'utf8');
    expect(plist).not.toMatch(/__[A-Z_]+__/);
    expect(plist).toContain(`<string>${label}</string>`);
    expect(plist).toContain(`<string>${path.join(repoRoot, 'deploy', 'radiocaster-agent.sh')}</string>`);
    expect(plist).toContain(`<string>${repoRoot}</string>`);
    expect(plist).toContain(`<string>${fs.realpathSync(node)}</string>`);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
  });

  it('fails clearly when node cannot be located', () => {
    const result = run('install-agent.sh', ['--render-only'], {
      RADIOCASTER_LAUNCH_AGENTS_DIR: tmp,
      RADIOCASTER_NODE: '',
      PATH: '/nonexistent',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/node/i);
    expect(fs.existsSync(path.join(tmp, `${label}.plist`))).toBe(false);
  });
});

describe('radiocaster-agent.sh', () => {
  it('starts the scheduler through ts-node and appends output to the log', () => {
    const logDir = path.join(tmp, 'logs');
    const result = run('radiocaster-agent.sh', [], {
      RADIOCASTER_NODE: fakeNode(),
      RADIOCASTER_LOG_DIR: logDir,
    });
    expect(result.status).toBe(0);

    const log = fs.readFileSync(path.join(logDir, 'radiocaster.log'), 'utf8');
    expect(log).toContain(`fake-node ${path.join('node_modules', '.bin', 'ts-node')} ${path.join('src', 'index.ts')}`);
  });

  it('rotates the log once it exceeds the size limit', () => {
    const logDir = path.join(tmp, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'radiocaster.log'), 'x'.repeat(200));

    const result = run('radiocaster-agent.sh', [], {
      RADIOCASTER_NODE: fakeNode(),
      RADIOCASTER_LOG_DIR: logDir,
      RADIOCASTER_LOG_MAX_BYTES: '100',
    });
    expect(result.status).toBe(0);

    expect(fs.readFileSync(path.join(logDir, 'radiocaster.log.1'), 'utf8')).toBe('x'.repeat(200));
    const fresh = fs.readFileSync(path.join(logDir, 'radiocaster.log'), 'utf8');
    expect(fresh).not.toContain('xxxx');
    expect(fresh).toContain('fake-node');
  });

  it('keeps a bounded number of rotated logs', () => {
    const logDir = path.join(tmp, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'radiocaster.log'), 'current'.padEnd(200, '.'));
    fs.writeFileSync(path.join(logDir, 'radiocaster.log.1'), 'one');
    fs.writeFileSync(path.join(logDir, 'radiocaster.log.2'), 'two');
    fs.writeFileSync(path.join(logDir, 'radiocaster.log.3'), 'three');

    run('radiocaster-agent.sh', [], {
      RADIOCASTER_NODE: fakeNode(),
      RADIOCASTER_LOG_DIR: logDir,
      RADIOCASTER_LOG_MAX_BYTES: '100',
    });

    expect(fs.readFileSync(path.join(logDir, 'radiocaster.log.1'), 'utf8')).toMatch(/^current/);
    expect(fs.readFileSync(path.join(logDir, 'radiocaster.log.2'), 'utf8')).toBe('one');
    expect(fs.readFileSync(path.join(logDir, 'radiocaster.log.3'), 'utf8')).toBe('two');
    expect(fs.existsSync(path.join(logDir, 'radiocaster.log.4'))).toBe(false);
  });

  it('leaves a small log alone', () => {
    const logDir = path.join(tmp, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'radiocaster.log'), 'earlier run\n');

    run('radiocaster-agent.sh', [], {
      RADIOCASTER_NODE: fakeNode(),
      RADIOCASTER_LOG_DIR: logDir,
    });

    const log = fs.readFileSync(path.join(logDir, 'radiocaster.log'), 'utf8');
    expect(log.startsWith('earlier run\n')).toBe(true);
    expect(fs.existsSync(path.join(logDir, 'radiocaster.log.1'))).toBe(false);
  });
});
