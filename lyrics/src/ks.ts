/**
 * Loads Kirtan Saathi (MIT, github.com/sethigoldy/Kirtan-saathi) from a built checkout at
 * KS_DIR: the corpus and the speech model, and makes engines in kirtan mode. Shared by the
 * live follower (server.ts) and the scoring CLI (score-file.ts). Not imported by tests.
 */
import path from 'path';
import { EngineLike } from './runner';

export const KS_DIR = process.env.KS_DIR ?? '/opt/kirtan-saathi';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const ks = (mod: string) => require(path.join(KS_DIR, 'dist', 'engine', mod));

export interface CorpusLike {
  plain: string[];
  shabadOf: Int32Array;
  lineInShabad: Int32Array;
  shabads: { id: string; source: number; section: string; page: number; start: number; count: number }[];
  sources: { name: string; nameEn: string }[];
  banis: { id: string; name: string; nameEn: string; lines: number[] }[];
}

/** Settings for KS's line tracker (engine/tracker.ts there): how kirtan moves between lines. */
export type TrackerOptions = Partial<{
  stay: number;
  next: number;
  toRahao: number;
  previous: number;
  other: number;
  beta: number;
  switchPosterior: number;
  switchMargin: number;
  switchHops: number;
  instantPosterior: number;
}>;

/** The live follower's line tracker settings (KS defaults where unset). */
export const LINE_TRACKER: TrackerOptions = {};

export interface EngineSettings {
  paceScale: number;
  tracker?: TrackerOptions;
  /**
   * Cache decoded windows here (KS's CachedTranscriber), keyed by position, so a recording can
   * be re-run with other tracker settings without the speech model. Scoring only.
   */
  asrCache?: { dir: string; id: string };
}

export interface Kirtan {
  corpus: CorpusLike;
  newEngine(settings: EngineSettings): EngineLike & { saveCache(): void };
}

export async function loadKirtanSaathi(threads: number): Promise<Kirtan> {
  const { Corpus } = ks('corpus');
  const { Retriever } = ks('retrieval');
  const { Engine } = ks('engine');
  const { AsrModel } = ks('asr');
  const corpus: CorpusLike = Corpus.load(path.join(KS_DIR, 'resources', 'corpus.json.gz'));
  const retriever = new Retriever(corpus);
  const model = await AsrModel.load(path.join(KS_DIR, 'models', 'model.int8.onnx'), path.join(KS_DIR, 'models', 'edge-vocab.json'), {
    intraOpThreads: threads,
  });
  return {
    corpus,
    newEngine({ paceScale, tracker, asrCache }) {
      let transcriber: any = { transcribe: (x: Float32Array, at: number) => model.transcribe(x, at) };
      if (asrCache) {
        const { CachedTranscriber } = require(path.join(KS_DIR, 'dist', 'cli', 'cached-asr'));
        transcriber = new CachedTranscriber(model, asrCache.dir, asrCache.id, 0);
      }
      const engine = new Engine(corpus, retriever, transcriber, { paceScale, ...(tracker ? { tracker } : {}) });
      engine.setMode({ kind: 'kirtan' });
      return Object.assign(engine as EngineLike, { saveCache: () => transcriber.save?.() });
    },
  };
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
