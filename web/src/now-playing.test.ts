import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchNowPlaying, statusLine } from './now-playing';
import type { NowPlaying } from './types';

const np = (over: Partial<NowPlaying>): NowPlaying => ({
  station: 'golden-temple', state: 'live', headline: 'Live', detail: null, resumesAt: null,
  updatedAt: '2026-10-13T18:00:00.000Z', ...over,
});
const fmt = (iso: string) => `T(${iso})`;

describe('statusLine', () => {
  it('says nothing for a station playing normally (the badge covers it)', () => {
    expect(statusLine(np({}), fmt)).toBeNull();
  });

  it('says nothing for off-air and unknown (the badge covers those too)', () => {
    expect(statusLine(np({ state: 'off-air', headline: 'Off air', detail: 'x' }), fmt)).toBeNull();
    expect(statusLine(np({ state: 'unknown', headline: 'Connecting' }), fmt)).toBeNull();
  });

  it('shows the warning for a live station that is cutting out', () => {
    expect(statusLine(np({ detail: 'Audio may cut out right now.' }), fmt)).toBe('Audio may cut out right now.');
  });

  it('gives the nightly break with the resume time in the listener\'s clock', () => {
    const line = statusLine(np({
      state: 'quiet', headline: 'Kirtan is paused for the night', resumesAt: '2026-10-13T21:15:00.000Z',
    }), fmt);
    expect(line).toBe('Kirtan is paused for the night. Usually resumes around T(2026-10-13T21:15:00.000Z).');
  });

  it('joins headline and detail when a station is down', () => {
    expect(statusLine(np({ state: 'down', headline: 'Having trouble reaching this station', detail: 'We\'ll keep trying.' }), fmt))
      .toBe('Having trouble reaching this station. We\'ll keep trying.');
  });
});

describe('fetchNowPlaying', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keys the /now-playing list by station', async () => {
    const fetchMock = vi.fn(async (_url: URL) => new Response(JSON.stringify([np({}), np({ station: 'san-jose', state: 'quiet' })])));
    vi.stubGlobal('fetch', fetchMock);
    const map = await fetchNowPlaying('https://stream.example');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://stream.example/now-playing');
    expect([...map.keys()]).toEqual(['golden-temple', 'san-jose']);
    expect(map.get('san-jose')?.state).toBe('quiet');
  });

  it('throws on a non-ok response so the caller keeps the last text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await expect(fetchNowPlaying('https://stream.example')).rejects.toThrow();
  });
});
