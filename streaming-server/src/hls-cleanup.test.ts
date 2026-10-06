import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanupHlsRoot } from './hls-cleanup';

describe('cleanupHlsRoot', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-cleanup-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content = 'x') {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }

  it('deletes segments the playlist no longer references (orphans from FFmpeg restarts)', () => {
    write('gt/stream.m3u8', '#EXTM3U\n#EXTINF:6,\nseg00010.ts\n#EXTINF:6,\nseg00011.ts\n');
    write('gt/seg00010.ts');
    write('gt/seg00011.ts');
    write('gt/seg00003.ts');
    write('gt/seg00004.ts');

    const removed = cleanupHlsRoot(root, ['gt']);

    expect(fs.readdirSync(path.join(root, 'gt')).sort()).toEqual(['seg00010.ts', 'seg00011.ts', 'stream.m3u8']);
    expect(removed).toBe(2);
  });

  it('deletes every segment of a station that has no playlist', () => {
    write('gt/seg00001.ts');
    cleanupHlsRoot(root, ['gt']);
    expect(fs.readdirSync(path.join(root, 'gt'))).toEqual([]);
  });

  it('removes directories of stations that are no longer configured', () => {
    write('old-station/stream.m3u8', '#EXTM3U\nseg00001.ts\n');
    write('old-station/seg00001.ts');
    cleanupHlsRoot(root, ['gt']);
    expect(fs.existsSync(path.join(root, 'old-station'))).toBe(false);
  });

  it('leaves non-station files at the root alone (status history, lost+found)', () => {
    write('_status-history.jsonl', '{}\n');
    fs.mkdirSync(path.join(root, 'lost+found'));
    cleanupHlsRoot(root, ['gt']);
    expect(fs.existsSync(path.join(root, '_status-history.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'lost+found'))).toBe(true);
  });

  it('does nothing when the root does not exist yet', () => {
    expect(cleanupHlsRoot(path.join(root, 'missing'), ['gt'])).toBe(0);
  });
});
