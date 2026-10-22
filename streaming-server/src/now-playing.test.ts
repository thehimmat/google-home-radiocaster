import { buildNowPlaying, nextUtcTime } from './now-playing';

const NOW = Date.parse('2026-10-13T18:00:00Z');
const GT_QUIET = { startUtc: '16:15', endUtc: '21:15' };

describe('buildNowPlaying', () => {
  const base = { station: 'golden-temple', now: NOW };

  it('says Live with no detail for a healthy live station', () => {
    expect(buildNowPlaying({ ...base, status: 'live', quality: 'healthy' })).toEqual({
      station: 'golden-temple',
      state: 'live',
      headline: 'Live',
      detail: null,
      resumesAt: null,
      updatedAt: '2026-10-13T18:00:00.000Z',
    });
  });

  it('treats a live station with no quality sample yet as live', () => {
    expect(buildNowPlaying({ ...base, status: 'live' }).state).toBe('live');
  });

  it('warns about cutting out when the source is choppy, without blaming anyone', () => {
    const np = buildNowPlaying({ ...base, status: 'live', quality: 'choppy' });
    expect(np.state).toBe('live');
    expect(np.detail).toBe('Audio may cut out right now.');
  });

  it('says quiet when a live source is silent', () => {
    const np = buildNowPlaying({ ...base, status: 'live', quality: 'silent' });
    expect(np.state).toBe('quiet');
    expect(np.headline).toBe('Quiet right now');
    expect(np.resumesAt).toBeNull();
  });

  it('gives the expected resume time when silent inside the station\'s quiet hours', () => {
    const np = buildNowPlaying({ ...base, status: 'live', quality: 'silent', quietHours: GT_QUIET });
    expect(np.state).toBe('quiet');
    expect(np.headline).toBe('Kirtan is paused for the night');
    expect(np.resumesAt).toBe('2026-10-13T21:15:00.000Z');
  });

  it('does not claim a nightly break when silent outside quiet hours', () => {
    const np = buildNowPlaying({
      ...base, now: Date.parse('2026-10-13T12:00:00Z'), status: 'live', quality: 'silent', quietHours: GT_QUIET,
    });
    expect(np.headline).toBe('Quiet right now');
    expect(np.resumesAt).toBeNull();
  });

  it('says Off air for a station the supervisor has off air', () => {
    const np = buildNowPlaying({ ...base, status: 'off-air' });
    expect(np.state).toBe('off-air');
    expect(np.headline).toBe('Off air');
  });

  it('reports source-down and our errors the same way (never whose fault)', () => {
    const a = buildNowPlaying({ ...base, status: 'source-down' });
    const b = buildNowPlaying({ ...base, status: 'error' });
    expect(a).toEqual(b);
    expect(a.state).toBe('down');
    expect(a.headline).toBe('Having trouble reaching this station');
  });

  it('is unknown before the first status check', () => {
    const np = buildNowPlaying({ ...base, status: undefined });
    expect(np.state).toBe('unknown');
    expect(np.headline).toBe('Connecting');
  });
});

describe('nextUtcTime', () => {
  it('returns today when the time is still ahead', () => {
    expect(new Date(nextUtcTime('21:15', NOW)).toISOString()).toBe('2026-10-13T21:15:00.000Z');
  });

  it('returns tomorrow when the time has passed', () => {
    expect(new Date(nextUtcTime('09:00', NOW)).toISOString()).toBe('2026-10-14T09:00:00.000Z');
  });
});

describe('quiet hours spanning midnight UTC', () => {
  const window = { startUtc: '22:00', endUtc: '02:00' };

  it('counts 23:30 and 01:00 as inside, and resumes at the next 02:00', () => {
    const late = buildNowPlaying({
      station: 's', now: Date.parse('2026-10-13T23:30:00Z'), status: 'live', quality: 'silent', quietHours: window,
    });
    expect(late.resumesAt).toBe('2026-10-14T02:00:00.000Z');
    const early = buildNowPlaying({
      station: 's', now: Date.parse('2026-10-14T01:00:00Z'), status: 'live', quality: 'silent', quietHours: window,
    });
    expect(early.resumesAt).toBe('2026-10-14T02:00:00.000Z');
  });
});
