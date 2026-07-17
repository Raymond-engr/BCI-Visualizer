import {
  BANDPASS_TABLE,
  NOTCH_TABLE,
  getBandpassCoefficients,
  getNotchCoefficients,
  applyIIR,
  bandpassFilter,
  notchFilter,
} from '../src/Signal_Processing/services/filters.service';

/** Generate a pure sine wave at the configured 250 Hz. */
const sine = (freq: number, samples: number, amplitude = 1): number[] =>
  Array.from(
    { length: samples },
    (_, i) => amplitude * Math.sin((2 * Math.PI * freq * i) / 250)
  );

/** RMS of the second half, after the filter has settled past its transient. */
const settledRms = (signal: number[]): number => {
  const tail = signal.slice(Math.floor(signal.length / 2));
  return Math.sqrt(tail.reduce((acc, v) => acc + v * v, 0) / tail.length);
};

describe('filters.service', () => {
  describe('coefficient tables', () => {
    it('carries a section for the default 8-30 Hz band', () => {
      expect(BANDPASS_TABLE['8-30@250']).toBeDefined();
    });

    it('carries sections for both mains frequencies', () => {
      expect(NOTCH_TABLE['50@250']).toBeDefined();
      expect(NOTCH_TABLE['60@250']).toBeDefined();
    });

    it('normalises every bandpass section so a[0] is unity', () => {
      Object.values(BANDPASS_TABLE).forEach(({ a }) => {
        expect(a[0]).toBeCloseTo(1, 10);
      });
    });

    it('gives every section matching numerator and denominator lengths', () => {
      Object.values(BANDPASS_TABLE).forEach(({ b, a }) => {
        expect(b.length).toBe(a.length);
      });
    });

    it('uses five-tap sections for the bandpass', () => {
      // butter(2, [low, high], btype='band') is order 2 per band edge.
      Object.values(BANDPASS_TABLE).forEach(({ b }) => {
        expect(b).toHaveLength(5);
      });
    });
  });

  describe('getBandpassCoefficients', () => {
    it('resolves the section for the configured band', () => {
      const { b, a } = getBandpassCoefficients();
      expect(b).toHaveLength(a.length);
      expect(a[0]).toBeCloseTo(1, 10);
    });
  });

  describe('getNotchCoefficients', () => {
    it('resolves the section for the configured mains frequency', () => {
      const { b, a } = getNotchCoefficients();
      expect(b).toHaveLength(3);
      expect(a).toHaveLength(3);
    });
  });

  describe('applyIIR', () => {
    it('leaves a signal unchanged under an identity filter', () => {
      const [y] = applyIIR([1, 2, 3, 4, 5], [1], [1], null);
      expect(y).toEqual([1, 2, 3, 4, 5]);
    });

    it('preserves signal length', () => {
      const { b, a } = getBandpassCoefficients();
      const [y] = applyIIR(sine(10, 500), b, a, null);
      expect(y).toHaveLength(500);
    });

    it('returns a delay line sized to the filter order', () => {
      const { b, a } = getBandpassCoefficients();
      const [, state] = applyIIR(sine(10, 100), b, a, null);
      expect(state).toHaveLength(b.length - 1);
    });

    it('gives the same result chunked as it does in one pass', () => {
      const { b, a } = getBandpassCoefficients();
      const signal = sine(10, 400);

      const [whole] = applyIIR(signal, b, a, null);

      const [first, state] = applyIIR(signal.slice(0, 200), b, a, null);
      const [second] = applyIIR(signal.slice(200), b, a, state);

      // This is the property that makes per-packet filtering valid at all: if
      // carrying the delay line did not reproduce the single-pass result, every
      // packet boundary would inject a transient.
      [...first, ...second].forEach((value, i) => {
        expect(value).toBeCloseTo(whole[i], 6);
      });
    });

    it('rings at the boundary when the delay line is discarded', () => {
      const { b, a } = getBandpassCoefficients();
      const signal = sine(10, 400);

      const [whole] = applyIIR(signal, b, a, null);
      const [first] = applyIIR(signal.slice(0, 200), b, a, null);
      const [restarted] = applyIIR(signal.slice(200), b, a, null);

      // Negative control for the test above.
      const stitched = [...first, ...restarted];
      const worst = Math.max(...stitched.map((v, i) => Math.abs(v - whole[i])));
      expect(worst).toBeGreaterThan(0.01);
    });
  });

  describe('bandpassFilter', () => {
    it('passes a 10 Hz component inside the band', () => {
      const input = sine(10, 1000);
      const [output] = bandpassFilter(input);
      expect(settledRms(output)).toBeGreaterThan(0.5 * settledRms(input));
    });

    it('attenuates a 2 Hz component below the band', () => {
      const input = sine(2, 1000);
      const [output] = bandpassFilter(input);
      expect(settledRms(output)).toBeLessThan(0.2 * settledRms(input));
    });

    it('attenuates a 60 Hz component above the band', () => {
      const input = sine(60, 1000);
      const [output] = bandpassFilter(input);
      expect(settledRms(output)).toBeLessThan(0.2 * settledRms(input));
    });

    it('recovers a band signal buried under drift and line noise', () => {
      const noisy = sine(10, 1000).map(
        (v, i) =>
          v +
          5 * Math.sin((2 * Math.PI * 0.5 * i) / 250) +
          2 * Math.sin((2 * Math.PI * 50 * i) / 250)
      );
      const [output] = bandpassFilter(noisy);

      // The 10 Hz component survives near unit amplitude while interference an
      // order of magnitude larger at the input does not.
      expect(settledRms(output)).toBeGreaterThan(0.3);
      expect(settledRms(output)).toBeLessThan(1.5);
    });

    it('threads its delay line across packets', () => {
      const [, state] = bandpassFilter(sine(10, 100));
      const [output] = bandpassFilter(sine(10, 100), state);
      expect(output).toHaveLength(100);
    });
  });

  describe('notchFilter', () => {
    it('suppresses mains-frequency noise', () => {
      const input = sine(50, 2000);
      const [output] = notchFilter(input);
      expect(settledRms(output)).toBeLessThan(0.2 * settledRms(input));
    });

    it('leaves a 10 Hz component essentially intact', () => {
      const input = sine(10, 1000);
      const [output] = notchFilter(input);
      expect(settledRms(output)).toBeGreaterThan(0.85 * settledRms(input));
    });

    it('leaves a 25 Hz component essentially intact', () => {
      const input = sine(25, 1000);
      const [output] = notchFilter(input);
      expect(settledRms(output)).toBeGreaterThan(0.85 * settledRms(input));
    });
  });
});
