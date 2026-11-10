import { rmsDb } from './level';

describe('rmsDb', () => {
  it('is 0 dB for a full-scale square wave and about -20 dB at a tenth of full scale', () => {
    expect(rmsDb(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(0, 5);
    expect(rmsDb(new Float32Array([0.1, -0.1, 0.1, -0.1]))).toBeCloseTo(-20, 5);
  });

  it('floors digital silence (and an empty chunk) at -120 dB', () => {
    expect(rmsDb(new Float32Array(16000))).toBe(-120);
    expect(rmsDb(new Float32Array(0))).toBe(-120);
  });
});
