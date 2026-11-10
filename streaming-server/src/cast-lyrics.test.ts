/**
 * The Cast receiver's lyrics logic (public/cast-lyrics.js, loaded as a plain script by
 * cast-skin.html). The DOM side is a thin layer over these and is checked by hand on a Hub.
 */

interface View {
  source: string;
  lines: string[];
  current: number;
  shabadId: string;
}

interface CastLyrics {
  eventsUrl(mediaUrl: string): string | null;
  lyricsView(data: unknown): View | null;
  follow(mediaUrl: string, onChange: (v: View | null) => void, EventSourceImpl: unknown): () => void;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lyrics = require('../public/cast-lyrics.js') as CastLyrics;

describe('eventsUrl', () => {
  it("points at the now-playing events of the station the device is playing", () => {
    expect(lyrics.eventsUrl('https://stream.atthebunga.com/golden-temple/stream')).toBe(
      'https://stream.atthebunga.com/now-playing/golden-temple/events',
    );
    expect(lyrics.eventsUrl('https://stream.atthebunga.com/golden-temple/playlist.m3u8')).toBe(
      'https://stream.atthebunga.com/now-playing/golden-temple/events',
    );
  });

  it('gives up on a URL it cannot read', () => {
    expect(lyrics.eventsUrl('not a url')).toBeNull();
    expect(lyrics.eventsUrl('https://stream.atthebunga.com/')).toBeNull();
  });
});

describe('lyricsView', () => {
  const showing = {
    station: 'golden-temple',
    state: 'showing',
    committed: true,
    shabad: { id: 'DH9', source: 'Sri Guru Granth Sahib', section: 'Raag Gauree', page: 201 },
    line: { index: 2, text: 'c' },
    lines: ['a', 'b', 'c'],
  };

  it('turns a shabad being shown into what the screen needs', () => {
    expect(lyrics.lyricsView(showing)).toEqual({
      source: 'Raag Gauree, Ang 201',
      lines: ['a', 'b', 'c'],
      current: 2,
      shabadId: 'DH9',
    });
  });

  it('has no current line when the follower has not placed one', () => {
    expect(lyrics.lyricsView({ ...showing, line: null })?.current).toBe(-1);
  });

  it('shows nothing when idle, unavailable, or malformed', () => {
    expect(lyrics.lyricsView({ station: 'golden-temple', state: 'idle', shabad: null, lines: null })).toBeNull();
    expect(lyrics.lyricsView({ station: 'golden-temple', state: 'unavailable' })).toBeNull();
    expect(lyrics.lyricsView(null)).toBeNull();
    expect(lyrics.lyricsView({ ...showing, lines: 'x' })).toBeNull();
  });
});

describe('follow', () => {
  class FakeSource {
    static last: FakeSource;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(readonly url: string) {
      FakeSource.last = this;
    }
    close() {
      this.closed = true;
    }
  }

  it('listens to the station, passes on views, clears on error, and stops', () => {
    const seen: (View | null)[] = [];
    const stop = lyrics.follow('https://s/golden-temple/stream', (v) => seen.push(v), FakeSource);
    expect(FakeSource.last.url).toBe('https://s/now-playing/golden-temple/events');

    FakeSource.last.onmessage?.({
      data: JSON.stringify({
        state: 'showing',
        shabad: { id: 'X', section: 'Raag Todee', page: 713 },
        line: { index: 0, text: 'a' },
        lines: ['a'],
      }),
    });
    FakeSource.last.onmessage?.({ data: 'not json' });
    FakeSource.last.onerror?.();
    expect(seen).toEqual([{ source: 'Raag Todee, Ang 713', lines: ['a'], current: 0, shabadId: 'X' }, null]);

    stop();
    expect(FakeSource.last.closed).toBe(true);
  });

  it('does nothing for a URL without a station', () => {
    const stop = lyrics.follow('nope', () => undefined, FakeSource);
    expect(() => stop()).not.toThrow();
  });
});
