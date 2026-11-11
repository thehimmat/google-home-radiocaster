import { programIndex } from './programs';

describe('programIndex', () => {
  // Lines 0-9: shabad 0..4, two lines each.
  const corpus = {
    shabadOf: Int32Array.from([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]),
    banis: [
      { id: 'ASKV', lines: [0, 1, 2, 3, 4] },
      { id: 'ANND', lines: [6, 7] },
      { id: 'ANN6', lines: [6] },
      { id: 'JAPJ', lines: [8, 9] },
    ],
  };

  it('names the programs each shabad is part of', () => {
    const of = programIndex(corpus);
    expect(of(0)).toEqual(['ASKV']);
    expect(of(2)).toEqual(['ASKV']);
    expect(of(3)).toEqual(['ANND', 'ANN6']);
  });

  it('leaves standalone shabads and other banis out', () => {
    const of = programIndex(corpus);
    expect(of(4)).toEqual([]); // Japji is recited as one, not a program of parts
    expect(of(99)).toEqual([]);
  });
});
