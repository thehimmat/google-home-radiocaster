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
