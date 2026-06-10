import { EventEmitter, PassThrough, Writable } from 'stream';
import { ChildProcess } from 'child_process';
import type { Response } from 'express';
import { StationBroadcaster, SpawnFn } from './broadcaster';

// Unit tests use tiny linger/restart values with real timers — each wait is
// tens of milliseconds, which keeps the suite fast without fake-timer hazards
// around stream I/O.

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

function makeBroadcaster(opts: ConstructorParameters<typeof StationBroadcaster>[3] = {}) {
  const procs: FakeProc[] = [];
  const fakeSpawn: SpawnFn = () => {
    const proc = new FakeProc();
    procs.push(proc);
    return proc as unknown as ChildProcess;
  };
  const broadcaster = new StationBroadcaster('test-station', 'https://example.com/up', fakeSpawn, opts);
  return { broadcaster, procs };
}

/** A client whose written bytes are collected; resume() keeps its buffer drained. */
function makeClient(): { res: Response; received: () => string; raw: PassThrough } {
  const raw = new PassThrough();
  const chunks: Buffer[] = [];
  raw.on('data', (c: Buffer) => chunks.push(c));
  return { res: raw as unknown as Response, received: () => Buffer.concat(chunks).toString(), raw };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('StationBroadcaster', () => {
  it('spawns one ffmpeg and fans chunks out to every client', async () => {
    const { broadcaster, procs } = makeBroadcaster();
    const a = makeClient();
    const b = makeClient();

    broadcaster.addClient(a.res);
    broadcaster.addClient(b.res);
    expect(procs).toHaveLength(1);
    expect(broadcaster.listenerCount).toBe(2);

    procs[0].stdout.write('adts-frame');
    await tick(10);
    expect(a.received()).toBe('adts-frame');
    expect(b.received()).toBe('adts-frame');
  });

  it('drops a slow client without affecting the others', async () => {
    const { broadcaster, procs } = makeBroadcaster({ maxClientBufferBytes: 4 });
    const fast = makeClient();
    // The slow client models a stalled socket: _write never completes, so
    // every written byte stays queued and writableLength grows.
    const slow = new Writable({ write() { /* never call the callback */ } });

    broadcaster.addClient(fast.res);
    broadcaster.addClient(slow as unknown as Response);

    procs[0].stdout.write('chunk-one'); // slow client buffers 9 bytes > 4 limit
    await tick(10);
    procs[0].stdout.write('chunk-two'); // over-limit check trips → slow client destroyed
    await tick(10);

    expect(slow.destroyed).toBe(true);
    expect(fast.received()).toBe('chunk-onechunk-two');
    expect(broadcaster.listenerCount).toBe(1);
  });

  it('kills ffmpeg only after the linger window once the last client leaves', async () => {
    const { broadcaster, procs } = makeBroadcaster({ lingerMs: 30 });
    const a = makeClient();

    broadcaster.addClient(a.res);
    a.raw.destroy();
    await tick(10);
    expect(broadcaster.listenerCount).toBe(0);
    expect(procs[0].killed).toBe(false); // still inside linger

    await tick(50);
    expect(procs[0].killed).toBe(true);
  });

  it('keeps ffmpeg alive when a client rejoins during linger', async () => {
    const { broadcaster, procs } = makeBroadcaster({ lingerMs: 40 });
    const a = makeClient();

    broadcaster.addClient(a.res);
    a.raw.destroy();
    await tick(10);
    broadcaster.addClient(makeClient().res); // rejoin cancels the linger timer

    await tick(80);
    expect(procs[0].killed).toBe(false);
    expect(procs).toHaveLength(1);
  });

  it('respawns ffmpeg if it dies while clients are connected', async () => {
    const { broadcaster, procs } = makeBroadcaster({ restartDelayMs: 10 });
    const a = makeClient();

    broadcaster.addClient(a.res);
    procs[0].emit('exit', 1, null); // crash, not a deliberate kill

    await tick(40);
    expect(procs).toHaveLength(2);
    expect(broadcaster.listenerCount).toBe(1); // client socket stayed open through the gap
  });

  it('stop() kills ffmpeg, drops clients, and never respawns', async () => {
    const { broadcaster, procs } = makeBroadcaster({ restartDelayMs: 5 });
    const a = makeClient();

    broadcaster.addClient(a.res);
    broadcaster.stop();

    await tick(30);
    expect(procs[0].killed).toBe(true);
    expect(procs).toHaveLength(1);
    expect(a.raw.destroyed).toBe(true);
    expect(broadcaster.listenerCount).toBe(0);
  });
});
