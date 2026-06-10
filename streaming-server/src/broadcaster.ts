import { ChildProcess, SpawnOptions } from 'child_process';
import type { Response } from 'express';
import { buildAdtsArgs } from './ffmpeg-args';

/** Matches child_process.spawn — injectable so tests can fake FFmpeg. */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface BroadcasterOpts {
  /** How long to keep FFmpeg alive after the last listener leaves. */
  lingerMs?: number;
  /** Delay before respawning FFmpeg if it dies while listeners are connected. */
  restartDelayMs?: number;
  /** A client whose write buffer exceeds this is dropped so it can't stall the rest. */
  maxClientBufferBytes?: number;
}

const DEFAULTS: Required<BroadcasterOpts> = {
  lingerMs: 60_000,
  restartDelayMs: 3_000,
  maxClientBufferBytes: 2 * 1024 * 1024,
};

/**
 * One FFmpeg per station, fanned out to every connected /stream client.
 *
 * Without this, each Cast listener spawned its own FFmpeg (~60MB RSS each),
 * capping the 512MB box at a handful of listeners. ADTS framing is
 * self-synchronizing (every frame starts with an 0xFFF syncword), so clients
 * that join mid-stream lock on at the next frame — no priming buffer needed.
 *
 * Lifecycle: lazily spawned on the first listener; kept alive for lingerMs
 * after the last listener leaves (Cast devices reconnect on hiccups);
 * respawned after restartDelayMs if FFmpeg dies while listeners remain —
 * their sockets stay open through the gap.
 */
export class StationBroadcaster {
  private readonly clients = new Set<Response>();
  private readonly opts: Required<BroadcasterOpts>;
  private proc: ChildProcess | null = null;
  private lingerTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly station: string,
    private readonly upstreamUrl: string,
    private readonly spawnFn: SpawnFn,
    opts: BroadcasterOpts = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  get listenerCount(): number {
    return this.clients.size;
  }

  addClient(res: Response): void {
    this.clients.add(res);
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    // Socket errors (client vanished mid-write) must not crash the process;
    // the 'close' handler below does the cleanup.
    res.on('error', () => { /* handled via close */ });
    res.on('close', () => this.removeClient(res));
    if (!this.proc && !this.restartTimer) this.start();
    console.log(`[stream:${this.station}] client connected (${this.clients.size} listening)`);
  }

  /** Kill FFmpeg and drop all clients — used on server shutdown. */
  stop(): void {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.lingerTimer = null;
    this.restartTimer = null;
    const proc = this.proc;
    this.proc = null; // cleared first so the exit handler doesn't respawn
    proc?.kill('SIGKILL');
    for (const res of this.clients) res.destroy();
    this.clients.clear();
  }

  private removeClient(res: Response): void {
    if (!this.clients.delete(res)) return;
    console.log(`[stream:${this.station}] client disconnected (${this.clients.size} listening)`);
    if (this.clients.size === 0) this.scheduleLinger();
  }

  private scheduleLinger(): void {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (this.clients.size > 0) return;
      const proc = this.proc;
      if (proc) {
        console.log(`[stream:${this.station}] no listeners for ${this.opts.lingerMs}ms — stopping ffmpeg (pid=${proc.pid})`);
        this.proc = null;
        proc.kill('SIGKILL');
      }
    }, this.opts.lingerMs);
  }

  private start(): void {
    const proc = this.spawnFn('ffmpeg', buildAdtsArgs(this.upstreamUrl), {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    this.proc = proc;
    console.log(`[stream:${this.station}] ffmpeg started (pid=${proc.pid})`);

    proc.stdout?.on('data', (chunk: Buffer) => this.fanOut(chunk));

    proc.on('exit', (code, signal) => {
      // A deliberate stop (linger/shutdown) clears this.proc first — ignore those.
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.clients.size === 0) return;
      console.log(
        `[stream:${this.station}] ffmpeg exited (code=${code} signal=${signal}) with ${this.clients.size} listening — restarting in ${this.opts.restartDelayMs}ms`,
      );
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.clients.size > 0 && !this.proc) this.start();
      }, this.opts.restartDelayMs);
    });
  }

  private fanOut(chunk: Buffer): void {
    for (const res of this.clients) {
      if (res.destroyed || res.writableEnded) continue;
      if (res.writableLength > this.opts.maxClientBufferBytes) {
        console.warn(`[stream:${this.station}] dropping slow client (${res.writableLength} bytes buffered)`);
        res.destroy(); // 'close' handler removes it from the set
        continue;
      }
      res.write(chunk);
    }
  }
}
