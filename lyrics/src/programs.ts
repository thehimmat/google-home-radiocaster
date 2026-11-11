/**
 * Programs sung at Darbar Sahib as a run of parts the corpus files as separate shabads, from
 * Kirtan Saathi's bani list (Shabad OS ids). The gate moves between parts of one program
 * quickly instead of treating each as a new shabad (#46).
 */
export const PROGRAM_BANIS = [
  'ASKV', // Asa ki Var: saloks, pauris and the chhants sung between them
  'ARTI', // Aarti
  'ARTL', // Aarti (longer)
  'ANND', // Anand Sahib
  'ANN6', // Anand Sahib (6 pauris and salok), sung at the close
  'MDVI', // Bhog: Mundavani and the saloks after it
] as const;

export interface CorpusWithBanis {
  shabadOf: Int32Array;
  banis: { id: string; lines: number[] }[];
}

/** shabad -> the programs it is part of (empty for a standalone shabad). */
export function programIndex(corpus: CorpusWithBanis, ids: readonly string[] = PROGRAM_BANIS): (shabad: number) => readonly string[] {
  const of = new Map<number, string[]>();
  for (const bani of corpus.banis) {
    if (!ids.includes(bani.id)) continue;
    for (const line of bani.lines) {
      const shabad = corpus.shabadOf[line];
      const list = of.get(shabad) ?? [];
      if (!list.includes(bani.id)) list.push(bani.id);
      of.set(shabad, list);
    }
  }
  return (shabad) => of.get(shabad) ?? [];
}
