import { isFatehText } from './fateh';

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
