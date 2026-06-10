import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StationArchiver, SegmentUploader, archiverEnvFromProcess } from './archiver';

function writePlaylist(dir: string, segments: string[]): void {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6'];
  for (const seg of segments) {
    lines.push('#EXTINF:6.0,', seg);
  }
  // mtimeMs comparisons need distinct timestamps; utimesSync makes it explicit.
  fs.writeFileSync(path.join(dir, 'stream.m3u8'), lines.join('\n'));
  fs.utimesSync(path.join(dir, 'stream.m3u8'), new Date(), new Date(Date.now() + Math.random() * 1000));
}

function makeUploader(failures = 0) {
  const uploads: { key: string; body: string }[] = [];
  let remainingFailures = failures;
  const uploader: SegmentUploader = {
    async upload(key, body) {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('simulated R2 outage');
      }
      uploads.push({ key, body: body.toString() });
    },
  };
  return { uploader, uploads };
}

describe('StationArchiver', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archiver-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uploads each playlist segment once with timestamped station keys', async () => {
    fs.writeFileSync(path.join(dir, 'seg00000.ts'), 'first');
    fs.writeFileSync(path.join(dir, 'seg00001.ts'), 'second');
    writePlaylist(dir, ['seg00000.ts', 'seg00001.ts']);

    const { uploader, uploads } = makeUploader();
    const archiver = new StationArchiver('golden-temple', dir, uploader);

    await archiver.scanOnce();
    await archiver.scanOnce(); // unchanged playlist — no re-uploads

    expect(uploads).toHaveLength(2);
    expect(uploads.map((u) => u.body)).toEqual(['first', 'second']);
    for (const { key } of uploads) {
      expect(key).toMatch(/^golden-temple\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.ts$/);
    }
  });

  it('uploads only newly-referenced segments as the playlist advances', async () => {
    fs.writeFileSync(path.join(dir, 'seg00000.ts'), 'a');
    writePlaylist(dir, ['seg00000.ts']);

    const { uploader, uploads } = makeUploader();
    const archiver = new StationArchiver('s', dir, uploader);
    await archiver.scanOnce();

    fs.writeFileSync(path.join(dir, 'seg00001.ts'), 'b');
    writePlaylist(dir, ['seg00000.ts', 'seg00001.ts']);
    await archiver.scanOnce();

    expect(uploads.map((u) => u.body)).toEqual(['a', 'b']);
  });

  it('retries a failed upload on the next scan', async () => {
    fs.writeFileSync(path.join(dir, 'seg00000.ts'), 'flaky');
    writePlaylist(dir, ['seg00000.ts']);

    const { uploader, uploads } = makeUploader(1);
    const archiver = new StationArchiver('s', dir, uploader);

    await archiver.scanOnce(); // fails, logged, not marked uploaded
    expect(uploads).toHaveLength(0);

    await archiver.scanOnce(); // retried even though playlist mtime is unchanged
    expect(uploads.map((u) => u.body)).toEqual(['flaky']);

    await archiver.scanOnce();
    expect(uploads).toHaveLength(1); // and never duplicated after success
  });

  it('does nothing when the playlist does not exist yet', async () => {
    const { uploader, uploads } = makeUploader();
    const archiver = new StationArchiver('s', dir, uploader);
    await archiver.scanOnce();
    expect(uploads).toHaveLength(0);
  });
});

describe('archiverEnvFromProcess', () => {
  const FULL = {
    R2_ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_BUCKET: 'bucket',
  };

  it('returns the parsed env when all variables are present', () => {
    expect(archiverEnvFromProcess(FULL)).toEqual({
      accountId: 'acct',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucket: 'bucket',
    });
  });

  it.each(Object.keys(FULL))('returns null when %s is missing', (missing) => {
    const env = { ...FULL } as Record<string, string>;
    delete env[missing];
    expect(archiverEnvFromProcess(env)).toBeNull();
  });
});
