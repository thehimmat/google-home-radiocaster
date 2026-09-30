import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadLocalConfig, mergeConfig } from './local-config';
import type { ScheduleEntry, StationConfig } from './config';

// The local override is what keeps a real device IP / name out of the tracked
// config.ts. These tests pin down the merge semantics (stations merge by key,
// schedule replaces wholesale) and that a *missing* override file is silently
// fine while a *broken* one is a loud error.

const defaults = {
  stations: {
    'Golden Temple': { url: 'https://relay/golden-temple/stream', contentType: 'audio/aac' },
    'SomaFM': { url: 'http://ice1.somafm.com/groovesalad-128-mp3' },
  } as Record<string, StationConfig>,
  schedule: [
    { cron: '0 6 * * *', station: 'Golden Temple', deviceName: 'Living Room display', volume: 30 },
  ] as ScheduleEntry[],
};

describe('mergeConfig', () => {
  it('returns the defaults untouched when there are no overrides', () => {
    expect(mergeConfig(defaults, {})).toEqual(defaults);
  });

  it('merges stations by key, overriding matches and adding new ones', () => {
    const merged = mergeConfig(defaults, {
      stations: {
        'SomaFM': { url: 'http://ice2.somafm.com/groovesalad-256-mp3' },
        'KEXP': { url: 'https://kexp.example/stream' },
      },
    });
    expect(merged.stations).toEqual({
      'Golden Temple': defaults.stations['Golden Temple'],
      'SomaFM': { url: 'http://ice2.somafm.com/groovesalad-256-mp3' },
      'KEXP': { url: 'https://kexp.example/stream' },
    });
    expect(merged.schedule).toEqual(defaults.schedule);
  });

  it('replaces the schedule wholesale when one is provided', () => {
    const schedule: ScheduleEntry[] = [
      { cron: '30 7 * * 1-5', station: 'Golden Temple', deviceName: 'Kitchen Display', deviceIp: '10.0.0.9' },
    ];
    expect(mergeConfig(defaults, { schedule }).schedule).toEqual(schedule);
  });

  it('treats an explicitly empty schedule as "no jobs", not "use defaults"', () => {
    expect(mergeConfig(defaults, { schedule: [] }).schedule).toEqual([]);
  });

  it('does not mutate the defaults it was given', () => {
    const snapshot = JSON.parse(JSON.stringify(defaults));
    mergeConfig(defaults, { stations: { 'SomaFM': { url: 'x' } }, schedule: [] });
    expect(defaults).toEqual(snapshot);
  });
});

describe('loadLocalConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radiocaster-local-config-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty override when no local config file exists', () => {
    expect(loadLocalConfig(dir)).toEqual({});
  });

  it('returns the exports of config.local when it exists', () => {
    fs.writeFileSync(
      path.join(dir, 'config.local.js'),
      `exports.schedule = [{ cron: '0 6 * * *', station: 'Golden Temple', deviceName: 'Kitchen Display', deviceIp: '192.168.0.5' }];`
    );
    expect(loadLocalConfig(dir)).toEqual({
      schedule: [{ cron: '0 6 * * *', station: 'Golden Temple', deviceName: 'Kitchen Display', deviceIp: '192.168.0.5' }],
    });
  });

  it('rethrows when the local config exists but fails to load', () => {
    fs.writeFileSync(path.join(dir, 'config.local.js'), `exports.schedule = [ this is not javascript`);
    // Match on the message: the SyntaxError comes from the module loader's
    // realm, so an `instanceof SyntaxError` check would be false under Jest.
    expect(() => loadLocalConfig(dir)).toThrow(/Unexpected identifier/);
  });

  it('rethrows a missing-module error raised from *inside* the local config', () => {
    // A MODULE_NOT_FOUND for some other module must not be mistaken for
    // "config.local is absent" — that would silently drop the user's overrides.
    fs.writeFileSync(path.join(dir, 'config.local.js'), `require('./does-not-exist');`);
    expect(() => loadLocalConfig(dir)).toThrow(/does-not-exist/);
  });
});
