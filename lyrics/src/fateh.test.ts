import { boundaryLines, isFatehText } from './fateh';

describe('isFatehText', () => {
  it('recognises the greeting said before and after each kirtan slot, however it is spelled', () => {
    expect(isFatehText('ਵਾਹਿਗੁਰੂ ਜੀ ਕੀ ਫ਼ਤਹ ॥')).toBe(true); // Zafarnama's line, as the engine matched it
    expect(isFatehText('ਵਾਹਿਗੁਰੂ ਜੀ ਕਾ ਖਾਲਸਾ ਵਾਹਿਗੁਰੂ ਜੀ ਕੀ ਫਤਿਹ')).toBe(true);
    expect(isFatehText('ਵਾਹਿਗੁਰੂਜੀਕਾਖਾਲਸਾ ਵਾਹਿਗੁਰੂਜੀਕੀਫਤਹਿ')).toBe(true);
  });

  it('does not match ordinary Gurbani lines that mention Waheguru', () => {
    expect(isFatehText('ਵਾਹਿਗੁਰੂ ਵਾਹਿਗੁਰੂ ਵਾਹਿਗੁਰੂ ਵਾਹਿ ਜੀਉ ॥')).toBe(false);
    expect(isFatehText('ਨਾਨਕ ਤੇ ਮੁਖ ਉਜਲੇ ਕੇਤੀ ਛੁਟੀ ਨਾਲਿ ॥੧॥')).toBe(false);
  });
});

describe('boundaryLines', () => {
  const corpus = {
    plain: ['ਹਰਿ ਹਰਿ ਹਰਿ ਗੁਨ ਗਾਵਹੁ ॥', 'ਵਾਹਿਗੁਰੂ ਜੀ ਕੀ ਫ਼ਤਹ ॥', 'ਦਿਗਰ ਨ ਕਸ ਕਿ ਬਿ ਗੁਫ਼ਤਨ', 'ਪ੍ਰਿਥਮ ਭਗੌਤੀ ਸਿਮਰਿ ਕੈ'],
    shabadOf: Int32Array.from([0, 1, 1, 2]),
    shabads: [{ section: 'Raag Kaydaaraa' }, { section: 'Zafarnama' }, { section: 'Vaar Sri Bhagauti Ji Ki' }],
  };

  it('covers every line of Zafarnama: on 2026-11-10 the greeting matched one of its lines, not the Fateh line', () => {
    expect([...boundaryLines(corpus)].sort()).toEqual([1, 2]);
  });
});
