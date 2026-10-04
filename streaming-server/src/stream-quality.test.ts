import { EventEmitter, PassThrough } from 'stream';
import { ChildProcess } from 'child_process';
import {
  attributeCause,
  buildSampleArgs,
  classifySample,
  sampleSource,
  SourceSample,
} from './stream-quality';
import { SpawnFn } from './broadcaster';

function sample(overrides: Partial<SourceSample> = {}): SourceSample {
  return { gotAudio: true, wallSeconds: 20, mediaSeconds: 20, silences: [], ...overrides };
}

describe('classifySample', () => {
  it('is down when no audio arrived', () => {
    expect(classifySample(sample({ gotAudio: false, mediaSeconds: 0 }))).toBe('down');
  });

  it('is healthy when audio arrives at real time with no dropouts', () => {
    expect(classifySample(sample())).toBe('healthy');
  });

  it('is silent when nearly all received audio is silence', () => {
    expect(classifySample(sample({ silences: [19] }))).toBe('silent');
  });

  it('is choppy when audio arrives slower than real time (source starving us)', () => {
    // Golden Temple on 2026-10-03: ~54s of audio per 92s of wall time.
    expect(classifySample(sample({ wallSeconds: 20, mediaSeconds: 12 }))).toBe('choppy');
  });

  it('is choppy when the audio has repeated short dropouts', () => {
    expect(classifySample(sample({ silences: [0.5, 0.8, 1.2] }))).toBe('choppy');
  });

  it('tolerates a single short pause (a breath between shabads)', () => {
    expect(classifySample(sample({ silences: [1.5] }))).toBe('healthy');
  });

  it('ignores long silences when counting dropouts', () => {
    expect(classifySample(sample({ silences: [5] }))).toBe('healthy');
  });
});

describe('attributeCause', () => {
  it('blames the source when the source itself is unhealthy', () => {
    expect(attributeCause('choppy', 0.6)).toBe('source');
    expect(attributeCause('down', null)).toBe('source');
    expect(attributeCause('silent', 1)).toBe('source');
  });

  it('blames us when the source is healthy but our pipeline is slow', () => {
    expect(attributeCause('healthy', 0.6)).toBe('us');
  });

  it('is none when the source is healthy and our pipeline keeps up (or is unknown)', () => {
    expect(attributeCause('healthy', 1)).toBe('none');
    expect(attributeCause('healthy', null)).toBe('none');
  });
});

describe('buildSampleArgs', () => {
  it('decodes the upstream to null with silencedetect and machine-readable progress', () => {
    const args = buildSampleArgs('https://example.com/live');
    expect(args).toEqual(expect.arrayContaining(['-i', 'https://example.com/live', '-f', 'null', '-progress', 'pipe:1']));
    expect(args.join(' ')).toContain('silencedetect=');
    // Same input quirks as the real pipeline (user-agent, self-signed TLS).
    expect(args).toEqual(expect.arrayContaining(['-user_agent', 'WinampMPEG/5.0', '-tls_verify', '0']));
  });
});

class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit('exit', null, 'SIGKILL');
    return true;
  }
}

describe('sampleSource', () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function setup() {
    let clock = 0;
    const proc = new FakeProc();
    const spawnFn: SpawnFn = () => proc as unknown as ChildProcess;
    const now = () => clock;
    const setClock = (ms: number) => { clock = ms; };
    return { proc, spawnFn, now, setClock };
  }

  it('measures media seconds received per wall second, after a warm-up', async () => {
    const { proc, spawnFn, now, setClock } = setup();
    const result = sampleSource('https://x', { spawnFn, now, sampleMs: 60, warmupMs: 2000 });

    // Connect burst: 3s of audio in the first second — excluded by warm-up.
    setClock(1000); proc.stdout.write('out_time_us=3000000\nprogress=continue\n');
    await tick(5);
    setClock(3000); proc.stdout.write('out_time_us=4000000\nprogress=continue\n');
    await tick(5);
    // 10s of wall, 6s of audio → 0.6x real time.
    setClock(13000); proc.stdout.write('out_time_us=10000000\nprogress=continue\n');
    await tick(5);

    const s = await result;
    expect(proc.killed).toBe(true);
    expect(s.gotAudio).toBe(true);
    expect(s.wallSeconds).toBeCloseTo(10);
    expect(s.mediaSeconds).toBeCloseTo(6);
  });

  it('collects silence durations, including one still open when sampling stops', async () => {
    const { proc, spawnFn, now, setClock } = setup();
    const result = sampleSource('https://x', { spawnFn, now, sampleMs: 40, warmupMs: 0 });

    setClock(1000); proc.stdout.write('out_time_us=1000000\n');
    proc.stderr.write('[silencedetect @ 0x1] silence_start: 2.5\n');
    proc.stderr.write('[silencedetect @ 0x1] silence_end: 3.25 | silence_duration: 0.75\n');
    proc.stderr.write('[silencedetect @ 0x1] silence_start: 8\n');
    setClock(11000); proc.stdout.write('out_time_us=10000000\n');
    await tick(5);

    const s = await result;
    expect(s.silences).toEqual([0.75, 2]);
  });

  it('reports no audio when ffmpeg never makes progress', async () => {
    const { proc, spawnFn, now } = setup();
    const s = await sampleSource('https://x', { spawnFn, now, sampleMs: 20, warmupMs: 0 });
    expect(proc.killed).toBe(true);
    expect(s.gotAudio).toBe(false);
  });

  it('resolves early when ffmpeg exits on its own (e.g. connection refused)', async () => {
    const { proc, spawnFn, now } = setup();
    const result = sampleSource('https://x', { spawnFn, now, sampleMs: 10_000, warmupMs: 0 });
    proc.emit('exit', 1, null);
    const s = await result;
    expect(s.gotAudio).toBe(false);
  });
});
