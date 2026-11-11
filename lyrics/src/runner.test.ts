import { EventEmitter, PassThrough } from 'stream';
import { ChildProcess } from 'child_process';
import { EngineLike, LyricsRunner, SourceStream, buildDecodeArgs } from './runner';
import { GateEvent } from './gate';

class FakeEngine implements EngineLike {
  pushed = 0;
  private queue: GateEvent[] = [];
  constructor(private readonly every: number, private readonly at: (t: number) => GateEvent) {}
  pushAudio(chunk: Float32Array): void {
    const before = this.pushed;
    this.pushed += chunk.length;
    for (let s = (Math.floor(before / this.every) + 1) * this.every; s <= this.pushed; s += this.every) {
      this.queue.push(this.at(s / 16000));
    }
  }
  due(): boolean { return this.queue.length > 0; }
  async step(): Promise<GateEvent | null> { return this.queue.shift() ?? null; }
}

describe('LyricsRunner', () => {
  it('measures each second of audio and passes every engine event to the gate, in order', async () => {
    const levels: [number, number][] = [];
    const events: number[] = [];
    const engine = new FakeEngine(8000, (t) => ({ t, shabad: 1, line: 1 }));
    const runner = new LyricsRunner(engine, {
      level: (t, db) => levels.push([t, Math.round(db)]),
      event: (ev) => events.push(ev.t),
    });
    // 2.5 s of a -20 dB tone, in uneven chunks.
    const tone = new Float32Array(40000).fill(0.1);
    await runner.feed(tone.subarray(0, 7000));
    await runner.feed(tone.subarray(7000, 30000));
    await runner.feed(tone.subarray(30000));
    expect(levels).toEqual([[1, -20], [2, -20]]);
    expect(events).toEqual([0.5, 1, 1.5, 2, 2.5]);
    expect(runner.streamSec).toBeCloseTo(2.5);
    expect(runner.backlogSec).toBe(0);
  });

  it('hands the engine audio in fixed 0.1 s pieces however it arrives, so runs repeat exactly', async () => {
    const sizes: number[] = [];
    const engine: EngineLike = {
      pushAudio: (chunk) => sizes.push(chunk.length),
      due: () => false,
      step: async () => null,
    };
    const runner = new LyricsRunner(engine, { level: () => undefined, event: () => undefined });
    const audio = new Float32Array(5000);
    await runner.feed(audio.subarray(0, 700));
    await runner.feed(audio.subarray(700, 4100));
    await runner.feed(audio.subarray(4100));
    expect(sizes).toEqual([1600, 1600, 1600]);
    expect(runner.streamSec).toBeCloseTo(4800 / 16000);
  });

  it('accepts raw f32le bytes split anywhere, even mid-sample', async () => {
    const engine = new FakeEngine(16000, (t) => ({ t, shabad: null, line: null }));
    const runner = new LyricsRunner(engine, { level: () => undefined, event: () => undefined });
    const bytes = Buffer.from(new Float32Array(16000).fill(0.5).buffer);
    await runner.feedBytes(bytes.subarray(0, 3));
    await runner.feedBytes(bytes.subarray(3, 40001));
    await runner.feedBytes(bytes.subarray(40001));
    expect(engine.pushed).toBe(16000);
  });
});

describe('buildDecodeArgs', () => {
  it('decodes our own station stream to 16 kHz mono float PCM on stdout', () => {
    const args = buildDecodeArgs('http://radio:3001/golden-temple/stream');
    expect(args).toEqual(expect.arrayContaining(['-i', 'http://radio:3001/golden-temple/stream', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1']));
  });
});

describe('SourceStream', () => {
  class FakeProc extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    kill(): boolean { this.emit('exit', null, 'SIGTERM'); return true; }
  }

  it('restarts ffmpeg after it exits, so a dropped stream recovers on its own', async () => {
    const procs: FakeProc[] = [];
    const chunks: Buffer[] = [];
    const source = new SourceStream('http://x', (b) => { chunks.push(b); }, {
      spawnFn: () => { const p = new FakeProc(); procs.push(p); return p as unknown as ChildProcess; },
      retryMs: 5,
    });
    source.start();
    procs[0].stdout.write(Buffer.from([1, 2, 3, 4]));
    procs[0].emit('exit', 1, null);
    await new Promise((r) => setTimeout(r, 30));
    expect(procs.length).toBe(2);
    source.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(procs.length).toBe(2);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4]));
  });
});
