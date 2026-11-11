import { afterEach, describe, expect, it, vi } from 'vitest';
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

  describe('waiting for the listener (the player plays behind live; the follower listens live)', () => {
    afterEach(() => vi.useRealTimers());
    const watchDelayed = (onChange: (n: NowPlaying | null) => void, delay: () => number) =>
      watchLyrics('golden-temple', onChange, { base: 'https://s', EventSourceImpl: FakeSource as never, delaySec: delay });

    it('holds each update for as long as the player is behind live', () => {
      vi.useFakeTimers();
      const seen: (NowPlaying | null)[] = [];
      watchDelayed((n) => seen.push(n), () => 18);
      FakeSource.last.push(np());
      vi.advanceTimersByTime(17_900);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(100);
      expect(seen).toEqual([np()]);
    });

    it('keeps updates in order when the delay shrinks', () => {
      vi.useFakeTimers();
      const seen: (number | undefined)[] = [];
      let delay = 18;
      watchDelayed((n) => seen.push(n?.line?.index), () => delay);
      FakeSource.last.push(np({ line: { index: 0, text: 'a' } }));
      delay = 5;
      vi.advanceTimersByTime(1000);
      FakeSource.last.push(np({ line: { index: 1, text: 'b' } }));
      vi.advanceTimersByTime(10_000);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(7000);
      expect(seen).toEqual([0, 1]);
    });

    it('drops pending updates when stopped', () => {
      vi.useFakeTimers();
      const seen: unknown[] = [];
      const stop = watchDelayed((n) => seen.push(n), () => 18);
      FakeSource.last.push(np());
      stop();
      vi.advanceTimersByTime(20_000);
      expect(seen).toEqual([]);
    });
  });
});
