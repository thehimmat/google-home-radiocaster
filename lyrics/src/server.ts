/**
 * Entry point: follows each configured station's own stream (from the radio container)
 * with the Kirtan Saathi engine and serves what to display at /now-playing/:station.
 *
 * Kirtan Saathi (MIT, github.com/sethigoldy/Kirtan-saathi) is fetched and built into the
 * image at a pinned commit (see Dockerfile); KS_DIR points at it. Not imported by tests.
 */
import fs from 'fs';
import path from 'path';
import { createServer, NowPlaying } from './app';
import { boundaryLines } from './fateh';
import { DisplayGate, GateNote } from './gate';
import { EngineLike, LyricsRunner, SAMPLE_RATE, SourceStream } from './runner';

const KS_DIR = process.env.KS_DIR ?? '/opt/kirtan-saathi';
const RADIO_URL = process.env.RADIO_URL ?? 'http://radio:3001';
const STATIONS = (process.env.LYRICS_STATIONS ?? 'golden-temple').split(',').map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.PORT ?? 3002);
const LOG_DIR = process.env.LYRICS_LOG_DIR ?? '/data/lyrics';
const THREADS = Number(process.env.LYRICS_THREADS ?? 1);
// Kirtan Saathi's pacer: 2 decodes half as often as its default, which the trial showed still
// follows kirtan. Measured per station: 0.33 to 0.4 of a core on an M2, 0.89 on kosh-db's Ampere A1.
const PACE = Number(process.env.LYRICS_PACE ?? 2);

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const ks = (mod: string) => require(path.join(KS_DIR, 'dist', 'engine', mod));
const { Corpus } = ks('corpus');
const { Retriever } = ks('retrieval');
const { Engine } = ks('engine');
const { AsrModel } = ks('asr');
/* eslint-enable @typescript-eslint/no-require-imports */

interface CorpusLike {
  plain: string[];
  shabadOf: Int32Array;
  lineInShabad: Int32Array;
  shabads: { id: string; source: number; section: string; page: number; start: number; count: number }[];
  sources: { name: string; nameEn: string }[];
}

async function main(): Promise<void> {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const corpus: CorpusLike = Corpus.load(path.join(KS_DIR, 'resources', 'corpus.json.gz'));
  const retriever = new Retriever(corpus);
  const model = await AsrModel.load(path.join(KS_DIR, 'models', 'model.int8.onnx'), path.join(KS_DIR, 'models', 'edge-vocab.json'), {
    intraOpThreads: THREADS,
  });
  const fatehLines = boundaryLines(corpus);
  console.log(`[lyrics] corpus ${corpus.plain.length} lines, ${fatehLines.size} boundary lines; threads=${THREADS} pace=${PACE}`);

  const describe = (station: string, gate: DisplayGate): NowPlaying => {
    const d = gate.current();
    const s = d.shabad === null ? null : corpus.shabads[d.shabad];
    return {
      station,
      state: d.state,
      reason: d.reason,
      committed: d.committed,
      since: d.since,
      updatedAt: new Date().toISOString(),
      shabad: s ? { id: s.id, source: corpus.sources[s.source]?.nameEn ?? '', section: s.section, page: s.page } : null,
      line: d.line === null ? null : { index: corpus.lineInShabad[d.line], text: corpus.plain[d.line] },
      lines: s ? corpus.plain.slice(s.start, s.start + s.count) : null,
    };
  };

  const followed = new Map<string, { gate: DisplayGate; runner: LyricsRunner }>();
  for (const station of STATIONS) {
    const log = fs.createWriteStream(path.join(LOG_DIR, `${station}.jsonl`), { flags: 'a' });
    const onNote = (n: GateNote) => {
      const s = n.shabad == null ? null : corpus.shabads[n.shabad];
      const entry = { ts: new Date().toISOString(), ...n, ...(s ? { id: s.id, section: s.section, page: s.page } : {}) };
      log.write(JSON.stringify(entry) + '\n');
      console.log(`[lyrics:${station}] ${n.kind}${s ? ` ${s.section} p${s.page}` : ''}${n.reason ? ` (${n.reason})` : ''} at ${n.t.toFixed(1)}s`);
    };
    const gate = new DisplayGate({ isBoundary: (line) => fatehLines.has(line), onNote });
    const engine: EngineLike = new Engine(corpus, retriever, { transcribe: (x: Float32Array, at: number) => model.transcribe(x, at) }, { paceScale: PACE });
    (engine as any).setMode({ kind: 'kirtan' });
    const runner = new LyricsRunner(engine, gate);
    new SourceStream(`${RADIO_URL}/${station}/stream`, (b) => { void runner.feedBytes(b); }).start();
    followed.set(station, { gate, runner });
  }

  // CPU per station-second of audio, so the budget on the shared VM is visible in the logs.
  let lastCpu = process.cpuUsage();
  let lastAudio = 0;
  setInterval(() => {
    const cpu = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    const audio = [...followed.values()].reduce((sum, f) => sum + f.runner.streamSec, 0);
    const perAudioSec = audio > lastAudio ? (cpu.user + cpu.system) / 1e6 / (audio - lastAudio) : null;
    lastAudio = audio;
    const backlog = Math.max(...[...followed.values()].map((f) => f.runner.backlogSec), 0);
    console.log(`[lyrics] cpu ${perAudioSec?.toFixed(2) ?? '-'} core-s per audio-s, backlog ${backlog.toFixed(1)}s, rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
  }, 60_000).unref();

  createServer({
    nowPlaying: (station) => {
      const f = followed.get(station);
      return f ? describe(station, f.gate) : undefined;
    },
    health: () => ({
      sampleRate: SAMPLE_RATE,
      stations: Object.fromEntries([...followed].map(([s, f]) => [s, { streamSec: f.runner.streamSec, backlogSec: f.runner.backlogSec }])),
    }),
  }).listen(PORT, () => console.log(`[lyrics] listening on ${PORT}, following ${STATIONS.join(', ')} from ${RADIO_URL}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
