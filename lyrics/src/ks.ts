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
}

export interface Kirtan {
  corpus: CorpusLike;
  newEngine(paceScale: number): EngineLike;
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
    newEngine(paceScale) {
      const engine = new Engine(corpus, retriever, { transcribe: (x: Float32Array, at: number) => model.transcribe(x, at) }, { paceScale });
      (engine as any).setMode({ kind: 'kirtan' });
      return engine as EngineLike;
    },
  };
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
