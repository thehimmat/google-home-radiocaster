import { STREAM_BASE } from './api';
import type { NowPlaying } from './types';

interface Options {
  base?: string;
  /** Injectable for tests. */
  EventSourceImpl?: typeof EventSource;
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
  source.onmessage = (e: MessageEvent<string>) => {
    let data: { state?: string; shabad?: unknown; lines?: unknown };
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    onChange(data.state === 'showing' && data.shabad && Array.isArray(data.lines) ? (data as NowPlaying) : null);
  };
  // The browser reconnects on its own after a network drop; until it does, show nothing stale.
  source.onerror = () => onChange(null);
  return () => source.close();
}
