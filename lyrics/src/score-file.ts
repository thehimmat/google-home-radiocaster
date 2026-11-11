/**
 * Scores the lyrics follower on a recording with known truth (issue #37).
 *
 *   node dist/score-file.js trace <audio> <trace.jsonl>
 *       Runs the engine over the audio as the live follower does (kirtan mode, LYRICS_PACE,
 *       LYRICS_THREADS) and records each second's loudness and every engine report.
 *       --asr-cache <dir>: keep decoded windows there; later runs reuse them, so only the
 *       first run needs the speech model's time. --tracker '{"next":0.02}': line tracker
 *       settings on top of LINE_TRACKER (ks.ts).
 *   node dist/score-file.js score <labels.json> <trace.jsonl> [--gate '{"confirmSec":20}'] [--json]
 *       Scores the raw engine and the display gate against the labels. Re-run with other gate
 *       settings without decoding again.
 *
 * Labels are Kirtan Saathi's caption labeller output (node dist/cli/caption-label.js <video>
 * in a KS checkout; needs tesseract with tessdata_best pan.traineddata), read from SGPC's
 * broadcasts, which show the line being sung. KS_DIR points at a built KS checkout.
 * Not imported by tests; the scoring itself is score.ts.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { boundaryLines } from './fateh';
import { DisplayGate, GateEvent, GateOptions } from './gate';
import { LINE_TRACKER, loadKirtanSaathi, TrackerOptions } from './ks';
import { programIndex } from './programs';
import { LyricsRunner, SAMPLE_RATE } from './runner';
import { replayTrace, Score, scoreTimeline, TraceEntry, Truth } from './score';

const THREADS = Number(process.env.LYRICS_THREADS ?? 1);
const PACE = Number(process.env.LYRICS_PACE ?? 2);

async function trace(audio: string, out: string, tracker: TrackerOptions, cacheDir: string | undefined): Promise<void> {
  const ks = await loadKirtanSaathi(THREADS);
  const engine = ks.newEngine({ paceScale: PACE, tracker, asrCache: cacheDir ? { dir: cacheDir, id: path.basename(audio) } : undefined });
  const file = fs.createWriteStream(out);
  const write = (e: TraceEntry) => file.write(JSON.stringify(e) + '\n');
  const runner = new LyricsRunner(engine, {
    level: (t, db) => write({ kind: 'level', t, db: Math.round(db * 10) / 10 }),
    event: (ev: GateEvent) => write({ kind: 'event', ...ev }),
  });
  const started = Date.now();
  const cpu0 = process.cpuUsage();
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', audio, '-f', 'f32le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1']);
  ff.stderr.pipe(process.stderr);
  ff.stdout.on('data', (b: Buffer) => {
    ff.stdout.pause();
    void runner.feedBytes(b).then(() => ff.stdout.resume());
  });
  await new Promise<void>((resolve, reject) => {
    ff.on('error', reject);
    ff.stdout.on('end', () => resolve());
  });
  await runner.feed(new Float32Array(0));
  engine.saveCache();
  await new Promise<void>((resolve) => file.end(resolve));
  const cpu = process.cpuUsage(cpu0);
  console.log(
    `traced ${runner.streamSec.toFixed(0)} s of audio in ${((Date.now() - started) / 1000).toFixed(0)} s, ` +
      `${((cpu.user + cpu.system) / 1e6 / runner.streamSec).toFixed(2)} core-s per audio-s`,
  );
}

interface LabelFile {
  segments: { start: number; end: number; line_idx: number; confidence?: number }[];
}

async function score(labelsPath: string, tracePath: string, gateOpts: GateOptions, asJson: boolean): Promise<void> {
  // The corpus only; the model is not needed to score.
  const ks = await loadKirtanSaathi(1);
  const corpus = ks.corpus;
  const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8')) as LabelFile;
  const truth: Truth[] = labels.segments.filter((s) => s.line_idx >= 0).map((s) => ({ start: s.start, end: s.end, line: s.line_idx }));
  const entries = fs.readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as TraceEntry);
  const end = Math.max(...entries.map((e) => e.t), ...truth.map((s) => s.end));
  const fateh = boundaryLines(corpus);
  const { raw, gated } = replayTrace(entries, () => new DisplayGate({ isBoundary: (line) => fateh.has(line), programOf: programIndex(corpus), ...gateOpts }));
  const shabadOf = (line: number) => corpus.shabadOf[line];
  const results = {
    raw: scoreTimeline(truth, raw, { shabadOf, end }),
    gated: scoreTimeline(truth, gated, { shabadOf, end }),
  };
  if (asJson) {
    console.log(JSON.stringify(results));
    return;
  }
  const name = (s: number) => `${corpus.shabads[s].section} p${corpus.shabads[s].page}`;
  const pct = (x: number, of: number) => (of > 0 ? `${((100 * x) / of).toFixed(0)}%` : '-');
  const row = (label: string, r: Score) =>
    `${label.padEnd(6)} right ${pct(r.rightShabadSec, r.labelledSec).padStart(4)}  wrong ${r.wrongShabadSec.toFixed(0).padStart(4)} s ` +
    `(lag ${r.lagSec.toFixed(0)}, early ${r.earlySec.toFixed(0)}, wrong lock ${r.wrongLockSec.toFixed(0)} = ${r.wrongLockPerHour.toFixed(0)} s/h)  missed ${pct(r.missedSec, r.labelledSec).padStart(4)}  ` +
    `right line ${pct(r.rightLineSec, r.rightShabadSec).padStart(4)} of right time  shown uncaptioned ${r.unlabelledShownSec.toFixed(0)} s`;
  console.log(`${labelsPath}: ${(results.raw.labelledSec / 60).toFixed(1)} min captioned of ${(end / 60).toFixed(1)} min`);
  console.log(row('raw', results.raw));
  console.log(row('gated', results.gated));
  console.log('shabads (gated): sung, first shown after, shown right');
  for (const s of results.gated.shabads) {
    const after = s.firstRight === null ? 'never' : `${(s.firstRight - s.start).toFixed(0)} s`;
    console.log(`  ${name(s.shabad).padEnd(28)} ${s.sungSec.toFixed(0).padStart(5)} s  ${after.padStart(6)}  ${pct(s.rightSec, s.sungSec)}`);
  }
}

async function main(): Promise<void> {
  const [cmd, a, b] = process.argv.slice(2);
  const opt = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  if (cmd === 'trace' && a && b) {
    const tracker = { ...LINE_TRACKER, ...(JSON.parse(opt('tracker') ?? '{}') as TrackerOptions) };
    return trace(a, b, tracker, opt('asr-cache'));
  }
  if (cmd === 'score' && a && b) return score(a, b, JSON.parse(opt('gate') ?? '{}') as GateOptions, process.argv.includes('--json'));
  console.error('usage: score-file.js trace <audio> <trace.jsonl> [--asr-cache DIR] [--tracker JSON] | score <labels.json> <trace.jsonl> [--gate JSON] [--json]');
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
