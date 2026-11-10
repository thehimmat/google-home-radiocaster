/**
 * The greeting a ragi says before and after each kirtan slot at Darbar Sahib:
 * "ਵਾਹਿਗੁਰੂ ਜੀ ਕਾ ਖਾਲਸਾ, ਵਾਹਿਗੁਰੂ ਜੀ ਕੀ ਫਤਹਿ". The engine matches it to a line of
 * Zafarnama. It marks a boundary (a new jatha, or Ardas or Hukamnama starting or
 * ending), so the display clears instead of showing it.
 */
const FATEH = /ਵਾਹਿਗੁਰੂਜੀਕੀਫ(?:ਤਹਿ|ਤਿਹ|ਤਹ)/;

/** Spaces, nukta, punctuation and Gurmukhi digits removed, so spellings compare equal. */
function squash(text: string): string {
  return text
    .replace(/਼/g, '') // nukta: ਫ਼ -> ਫ
    .replace(/[\s॥।੦-੯;.,]/g, '');
}

export function isFatehText(text: string): boolean {
  return FATEH.test(squash(text));
}

/**
 * Corpus lines that mean "boundary", not lyrics: the Fateh greeting wherever it appears, and
 * every line of Zafarnama, which the engine reaches for when it hears the greeting (live on
 * 2026-11-10 it showed a Zafarnama line for 18 s at the end of Asa di Vaar). Zafarnama is
 * not sung in Darbar Sahib's kirtan.
 */
export function boundaryLines(corpus: {
  plain: string[];
  shabadOf: Int32Array;
  shabads: { section: string }[];
}): Set<number> {
  const out = new Set<number>();
  corpus.plain.forEach((text, i) => {
    if (isFatehText(text) || corpus.shabads[corpus.shabadOf[i]]?.section === 'Zafarnama') out.add(i);
  });
  return out;
}
