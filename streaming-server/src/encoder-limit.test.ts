import { maxEncodersFromEnv, DEFAULT_MAX_ENCODERS } from './encoder-limit';

describe('maxEncodersFromEnv', () => {
  it('defaults to 3 when unset', () => {
    expect(DEFAULT_MAX_ENCODERS).toBe(3);
    expect(maxEncodersFromEnv(undefined)).toBe(3);
    expect(maxEncodersFromEnv('')).toBe(3);
  });

  it('reads a positive integer', () => {
    expect(maxEncodersFromEnv('6')).toBe(6);
    expect(maxEncodersFromEnv(' 4 ')).toBe(4);
  });

  it('throws on anything else, so a typo fails the deploy instead of silently capping', () => {
    for (const bad of ['0', '-1', '2.5', 'six', '3x']) {
      expect(() => maxEncodersFromEnv(bad)).toThrow(/MAX_ENCODERS/);
    }
  });
});
