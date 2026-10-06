import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StatusHistory, StatusEvent } from './status-history';

const DAY_MS = 24 * 60 * 60 * 1000;

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-history-'));
  return path.join(dir, 'nested', 'status.jsonl');
}

function event(station: string, ts: string, to: StatusEvent['to'] = 'live'): StatusEvent {
  return { ts, station, from: null, to, upstreamReachable: null };
}

describe('StatusHistory', () => {
  it('appends events and reads them back in order, creating the directory', () => {
    const history = new StatusHistory(tmpFile());
    history.record(event('a', '2026-10-01T00:00:00.000Z'));
    history.record(event('b', '2026-10-01T00:01:00.000Z', 'error'));

    expect(history.read().map((e) => e.station)).toEqual(['a', 'b']);
  });

  it('survives a restart (reads what an earlier instance wrote)', () => {
    const file = tmpFile();
    new StatusHistory(file).record(event('a', '2026-10-01T00:00:00.000Z'));
    expect(new StatusHistory(file).read()).toHaveLength(1);
  });

  it('filters by station and since', () => {
    const history = new StatusHistory(tmpFile());
    history.record(event('a', '2026-10-01T00:00:00.000Z'));
    history.record(event('b', '2026-10-02T00:00:00.000Z'));
    history.record(event('a', '2026-10-03T00:00:00.000Z'));

    expect(history.read({ station: 'a' })).toHaveLength(2);
    expect(history.read({ since: Date.parse('2026-10-02T00:00:00.000Z') })).toHaveLength(2);
    expect(history.read({ station: 'a', since: Date.parse('2026-10-02T00:00:00.000Z') })).toHaveLength(1);
  });

  it('returns only the newest events when a limit is given', () => {
    const history = new StatusHistory(tmpFile());
    for (let i = 0; i < 5; i++) history.record(event(`s${i}`, `2026-10-01T00:0${i}:00.000Z`));
    expect(history.read({ limit: 2 }).map((e) => e.station)).toEqual(['s3', 's4']);
  });

  it('returns an empty list when nothing has been recorded', () => {
    expect(new StatusHistory(tmpFile()).read()).toEqual([]);
  });

  it('skips corrupt lines instead of failing the whole read', () => {
    const file = tmpFile();
    const history = new StatusHistory(file);
    history.record(event('a', '2026-10-01T00:00:00.000Z'));
    fs.appendFileSync(file, '{not json\n');
    history.record(event('b', '2026-10-01T00:01:00.000Z'));
    expect(history.read().map((e) => e.station)).toEqual(['a', 'b']);
  });

  it('prunes events older than the retention window', () => {
    const now = Date.parse('2026-10-31T00:00:00.000Z');
    const history = new StatusHistory(tmpFile(), 30 * DAY_MS, () => now);
    history.record(event('old', new Date(now - 31 * DAY_MS).toISOString()));
    history.record(event('new', new Date(now - 1 * DAY_MS).toISOString()));

    history.prune();
    expect(history.read().map((e) => e.station)).toEqual(['new']);
  });

  it('never throws from prune when the disk write fails (e.g. ENOSPC at boot), and keeps the log', () => {
    const file = tmpFile();
    const history = new StatusHistory(file);
    history.record(event('a', new Date().toISOString()));
    // A directory where the temp file goes makes the write fail, like a full disk.
    fs.mkdirSync(`${file}.tmp`);

    expect(() => history.prune()).not.toThrow();
    expect(history.read()).toHaveLength(1);
  });
});
