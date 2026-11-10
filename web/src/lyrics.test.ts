import { describe, expect, it } from 'vitest';
import { watchLyrics } from './lyrics';
import type { NowPlaying } from './types';

/** Stands in for EventSource: records the URL and lets the test push messages. */
class FakeSource {
  static last: FakeSource;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  closed = false;
  constructor(readonly url: string) {
    FakeSource.last = this;
  }
  close() {
    this.closed = true;
  }
  push(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const np = (over: Partial<NowPlaying> = {}): NowPlaying => ({
  station: 'golden-temple',
  state: 'showing',
  committed: true,
  shabad: { id: '3JP', source: 'Sri Guru Granth Sahib', section: 'Raag Todee', page: 713 },
  line: { index: 1, text: 'b' },
  lines: ['a', 'b', 'c'],
  ...over,
});

const watch = (onChange: (n: NowPlaying | null) => void) =>
  watchLyrics('golden-temple', onChange, { base: 'https://s', EventSourceImpl: FakeSource as never });

describe('watchLyrics', () => {
  it("listens to the station's now-playing event stream", () => {
    watch(() => undefined);
    expect(FakeSource.last.url).toBe('https://s/now-playing/golden-temple/events');
  });

  it('passes on a shabad being shown, and null when nothing is', () => {
    const seen: (NowPlaying | null)[] = [];
    watch((n) => seen.push(n));
    FakeSource.last.push(np());
    FakeSource.last.push({ station: 'golden-temple', state: 'idle', shabad: null, line: null, lines: null });
    FakeSource.last.push({ station: 'golden-temple', state: 'unavailable' });
    expect(seen).toEqual([np(), null, null]);
  });

  it('ignores a message it cannot read', () => {
    const seen: unknown[] = [];
    watch((n) => seen.push(n));
    FakeSource.last.onmessage?.({ data: 'not json' });
    expect(seen).toEqual([]);
  });

  it('clears the panel when the stream fails, and stops cleanly', () => {
    const seen: unknown[] = [];
    const stop = watch((n) => seen.push(n));
    FakeSource.last.onerror?.();
    expect(seen).toEqual([null]);
    stop();
    expect(FakeSource.last.closed).toBe(true);
  });
});
