import { describe, expect, it } from 'vitest';
import { pickTransport } from './player';

describe('pickTransport', () => {
  it('prefers hls.js wherever MSE is available', () => {
    expect(pickTransport(true, false)).toBe('hls.js');
    // Safari claims native HLS too — hls.js still wins for consistent behavior.
    expect(pickTransport(true, true)).toBe('hls.js');
  });

  it('uses native HLS when hls.js is unsupported (iOS Safari)', () => {
    expect(pickTransport(false, true)).toBe('native-hls');
  });

  it('falls back to the raw AAC stream when no HLS path exists', () => {
    expect(pickTransport(false, false)).toBe('raw-aac');
  });
});
