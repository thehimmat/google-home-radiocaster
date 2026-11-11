import { STREAM_BASE } from './api';
import type { NowPlaying } from './types';

interface Options {
  base?: string;
  /** Injectable for tests. */
  EventSourceImpl?: typeof EventSource;
  /**
   * Seconds the listener is behind live. The follower listens to the live stream, so each update
   * is held this long to land when the listener hears the change (the web player measured 18.6 s
   * behind live on HLS, 2026-11-11). Read afresh for each update.
   */
  delaySec?: () => number;
}

/**
 * Follows the shabad being sung on a station through the server's event stream, which pushes only
 * when the shabad or line changes. `onChange(null)` means show nothing: no shabad yet, a pause in the
 * singing, the follower being down, or a station without lyrics (the server answers 404 and the
 * browser gives up). Returns a function that stops listening.
 */
export function watchLyrics(slug: string, onChange: (np: NowPlaying | null) => void, opts: Options = {}): () => void {
  const Impl = opts.EventSourceImpl ?? EventSource;
  const source = new Impl(new URL(`/now-playing/${encodeURIComponent(slug)}/events`, opts.base ?? STREAM_BASE).toString());
  const timers = new Set<ReturnType<typeof setTimeout>>();
  // When the next update may land at the earliest: updates never overtake each other, even if the
  // delay shrinks in between.
  let lastAt = 0;
  const deliver = (np: NowPlaying | null) => {
    const delayMs = Math.max(0, (opts.delaySec?.() ?? 0) * 1000);
    const now = Date.now();
    const at = Math.max(now + delayMs, lastAt);
    lastAt = at;
    if (at <= now && timers.size === 0) {
      onChange(np);
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      onChange(np);
    }, at - now);
    timers.add(timer);
  };
  source.onmessage = (e: MessageEvent<string>) => {
    let data: { state?: string; shabad?: unknown; lines?: unknown };
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    deliver(data.state === 'showing' && data.shabad && Array.isArray(data.lines) ? (data as NowPlaying) : null);
  };
  // The browser reconnects on its own after a network drop; until it does, show nothing stale.
  source.onerror = () => onChange(null);
  return () => {
    source.close();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
