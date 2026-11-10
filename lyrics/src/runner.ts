import { ChildProcess, spawn } from 'child_process';
import { GateEvent } from './gate';
import { rmsDb } from './level';

export const SAMPLE_RATE = 16000;

/** What the runner needs from Kirtan Saathi's Engine (engine/engine.ts there). */
export interface EngineLike {
  pushAudio(chunk: Float32Array): void;
  due(): boolean;
  step(): Promise<GateEvent | null>;
}

export interface GateLike {
  level(t: number, db: number): void;
  event(ev: GateEvent): void;
}

/**
 * Feeds decoded audio to the engine and the gate. Measures the loudness of each whole
 * second for the gate's silence check, and runs every engine step that is due before
 * taking the next chunk, so events reach the gate in stream order.
 */
export class LyricsRunner {
  private samples = 0;
  private received = 0;
  private second = new Float32Array(SAMPLE_RATE);
  private secondFill = 0;
  private carry = Buffer.alloc(0);
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly engine: EngineLike, private readonly gate: GateLike) {}

  get streamSec(): number {
    return this.samples / SAMPLE_RATE;
  }

  /** Audio received but not yet processed: grows when the engine can't keep up. */
  get backlogSec(): number {
    return (this.received - this.samples) / SAMPLE_RATE;
  }

  /** Raw f32le bytes from ffmpeg, split anywhere. Calls are queued, never run concurrently. */
  feedBytes(bytes: Buffer): Promise<void> {
    const all = this.carry.length ? Buffer.concat([this.carry, bytes]) : bytes;
    const usable = all.length - (all.length % 4);
    this.carry = Buffer.from(all.subarray(usable));
    if (usable === 0) return this.chain;
    // Copy into an aligned buffer: Float32Array needs a 4-byte-aligned offset.
    const floats = new Float32Array(usable / 4);
    Buffer.from(floats.buffer).set(all.subarray(0, usable));
    return this.feed(floats);
  }

  feed(chunk: Float32Array): Promise<void> {
    this.received += chunk.length;
    this.chain = this.chain.then(() => this.process(chunk));
    return this.chain;
  }

  private async process(chunk: Float32Array): Promise<void> {
    for (let i = 0; i < chunk.length; ) {
      const n = Math.min(chunk.length - i, SAMPLE_RATE - this.secondFill);
      this.second.set(chunk.subarray(i, i + n), this.secondFill);
      this.secondFill += n;
      i += n;
      if (this.secondFill === SAMPLE_RATE) {
        this.gate.level((this.samples + i) / SAMPLE_RATE, rmsDb(this.second));
        this.secondFill = 0;
      }
    }
    this.samples += chunk.length;
    this.engine.pushAudio(chunk);
    while (this.engine.due()) {
      const ev = await this.engine.step();
      if (ev) this.gate.event(ev);
    }
  }
}

/** ffmpeg: our station stream in, 16 kHz mono float PCM out, at the stream's own pace. */
export function buildDecodeArgs(url: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
    '-i', url,
    '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1',
  ];
}

export type SpawnFn = (cmd: string, args: string[]) => ChildProcess;

/** Keeps one ffmpeg decoding a station, restarting it whenever it exits. */
export class SourceStream {
  private proc: ChildProcess | null = null;
  private stopped = false;
  private readonly spawnFn: SpawnFn;
  private readonly retryMs: number;

  constructor(
    private readonly url: string,
    private readonly onData: (bytes: Buffer) => void,
    opts: { spawnFn?: SpawnFn; retryMs?: number } = {},
  ) {
    this.spawnFn = opts.spawnFn ?? ((cmd, args) => spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    this.retryMs = opts.retryMs ?? 5000;
  }

  start(): void {
    if (this.stopped) return;
    const proc = this.spawnFn('ffmpeg', buildDecodeArgs(this.url));
    this.proc = proc;
    proc.stdout?.on('data', (b: Buffer) => this.onData(b));
    proc.stderr?.on('data', (b: Buffer) => process.stderr.write(`[lyrics:ffmpeg] ${b}`));
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (!this.stopped) setTimeout(() => this.start(), this.retryMs);
    });
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
  }
}
