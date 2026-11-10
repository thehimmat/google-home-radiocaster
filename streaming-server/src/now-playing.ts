/**
 * Relays the lyrics follower's now-playing state (lyrics/, a separate container on kosh-db reachable
 * only inside the server) to the public: GET /now-playing/:station and an SSE stream of changes at
 * /now-playing/:station/events. One poller per station runs only while someone is listening to the
 * events, so a page left open doesn't multiply load on the follower.
 */

export interface UpstreamAnswer {
  status: number;
  body?: unknown;
}

/** Fetches the follower's answer for a station. Throws when the follower is unreachable. */
export type Upstream = (station: string) => Promise<UpstreamAnswer>;

export function httpUpstream(baseUrl: string, timeoutMs = 3000): Upstream {
  const base = baseUrl.replace(/\/$/, '');
  return async (station) => {
    const res = await fetch(`${base}/now-playing/${encodeURIComponent(station)}`, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
}

export interface RelayOptions {
  /** How often to ask the follower, and how long a GET answer is reused. */
  pollMs?: number;
}

type Send = (data: unknown) => void;

interface Watch {
  subscribers: Set<Send>;
  timer: ReturnType<typeof setInterval>;
  /** What was last pushed, minus `updatedAt` (which changes on every engine event). */
  lastKey: string | null;
}

/** Sent to subscribers when the follower can't be reached. */
const unavailable = (station: string) => ({ station, state: 'unavailable' });

export class NowPlayingRelay {
  private readonly pollMs: number;
  private readonly cache = new Map<string, { at: number; answer: Promise<UpstreamAnswer> }>();
  private readonly watches = new Map<string, Watch>();

  constructor(private readonly upstream: Upstream, opts: RelayOptions = {}) {
    this.pollMs = opts.pollMs ?? 2000;
  }

  /** The follower's answer, reused for pollMs; 503 when it can't be reached. */
  get(station: string): Promise<UpstreamAnswer> {
    const hit = this.cache.get(station);
    if (hit && Date.now() - hit.at < this.pollMs) return hit.answer;
    const answer = this.upstream(station).catch((): UpstreamAnswer => ({ status: 503, body: unavailable(station) }));
    this.cache.set(station, { at: Date.now(), answer });
    return answer;
  }

  /** Calls `send` now and whenever what is shown changes. Returns the unsubscribe function. */
  subscribe(station: string, send: Send): () => void {
    let w = this.watches.get(station);
    if (!w) {
      const watch: Watch = { subscribers: new Set(), lastKey: null, timer: setInterval(() => void this.poll(station, watch), this.pollMs) };
      w = watch;
      this.watches.set(station, w);
      void this.poll(station, w);
    } else if (w.lastKey !== null) {
      // A late joiner gets the current state straight away.
      void this.get(station).then((a) => send(a.status === 200 ? a.body : unavailable(station)));
    }
    w.subscribers.add(send);
    const watch = w;
    return () => {
      watch.subscribers.delete(send);
      if (watch.subscribers.size === 0 && this.watches.get(station) === watch) {
        clearInterval(watch.timer);
        this.watches.delete(station);
      }
    };
  }

  private async poll(station: string, w: Watch): Promise<void> {
    const a = await this.get(station);
    const data = a.status === 200 ? a.body : unavailable(station);
    const key = JSON.stringify(data, (k, v) => (k === 'updatedAt' ? undefined : v));
    if (key === w.lastKey) return;
    w.lastKey = key;
    for (const send of w.subscribers) send(data);
  }
}
