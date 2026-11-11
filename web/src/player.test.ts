import { describe, expect, it } from 'vitest';
import { pickTransport, playbackLatency } from './player';

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

describe('playbackLatency', () => {
  const base = { paused: false, currentTime: 100, seekableEnd: 118.5, bufferedEnd: 112, hlsLatency: NaN };

  it('is how far behind live the listener hears: hls.js reports it, else the live edge', () => {
    expect(playbackLatency('hls.js', { ...base, hlsLatency: 19.2 })).toBeCloseTo(19.2);
    expect(playbackLatency('hls.js', base)).toBeCloseTo(18.5);
    expect(playbackLatency('native-hls', base)).toBeCloseTo(18.5);
  });

  it('is the buffered audio for the raw stream, which arrives from the live edge', () => {
    expect(playbackLatency('raw-aac', base)).toBeCloseTo(12);
  });

  it('is zero when nothing is playing, and never negative or absurd', () => {
    expect(playbackLatency('hls.js', { ...base, paused: true, hlsLatency: 19 })).toBe(0);
    expect(playbackLatency('raw-aac', { ...base, bufferedEnd: 90 })).toBe(0);
    expect(playbackLatency('native-hls', { ...base, seekableEnd: 1e9 })).toBe(0);
  });
});
