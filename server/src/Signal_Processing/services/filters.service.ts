import { filterConfig, streamingConfig } from '../../config/streaming';
import { AppError } from '../../utils/customErrors';

/**
 * IIR filtering for the streaming pipeline.
 *
 * Filter *design* is not reimplemented in TypeScript. The coefficients below
 * were computed offline with SciPy and pasted in verbatim, which guarantees the
 * server filters a sample exactly the way the Python training pipeline filtered
 * it — a mismatch here would silently shift the CSP feature distribution away
 * from what the model was fitted on.
 *
 *   from scipy.signal import butter, iirnotch
 *   butter(2, [8, 30], btype='band', fs=250)
 *   iirnotch(50.0, 35.0, 250)
 */

export type Coefficients = { b: number[]; a: number[] };

/** Second-order Butterworth bandpass sections, keyed `low-high@fs`. */
export const BANDPASS_TABLE: Record<string, Coefficients> = {
  '8-30@250': {
    b: [0.0543278611, 0.0, -0.1086557222, 0.0, 0.0543278611],
    a: [1.0, -2.9921588268, 3.5418516665, -1.9921792923, 0.4584120579],
  },
  '4-40@250': {
    b: [0.1227965526, 0.0, -0.2455931052, 0.0, 0.1227965526],
    a: [1.0, -2.643772158, 2.6558563814, -1.2914149004, 0.2853554015],
  },
  '8-12@250': {
    b: [0.0023572088, 0.0, -0.0047144175, 0.0, 0.0023572088],
    a: [1.0, -3.7415615286, 5.3619937381, -3.4845083401, 0.8674721338],
  },
  '13-30@250': {
    b: [0.0347615964, 0.0, -0.0695231927, 0.0, 0.0347615964],
    a: [1.0, -2.9901961228, 3.682591758, -2.1948211805, 0.546781099],
  },
  '1-45@250': {
    b: [0.1689959601, 0.0, -0.3379919203, 0.0, 0.1689959601],
    a: [1.0, -2.5091315079, 2.2686798614, -0.9845630515, 0.2254591599],
  },
};

/** Mains notch sections (Q = 35), keyed `freq@fs`. */
export const NOTCH_TABLE: Record<string, Coefficients> = {
  '50@250': {
    b: [0.9823627701, -0.6071335812, 0.9823627701],
    a: [1.0, -0.6071335812, 0.9647255402],
  },
  '60@250': {
    b: [0.9789087429, -0.1229323771, 0.9789087429],
    a: [1.0, -0.1229323771, 0.9578174858],
  },
};

/**
 * Resolve the configured bandpass coefficients.
 * @throws AppError when the configured band has no precomputed section, since
 *         silently substituting a different band would corrupt every result.
 */
export function getBandpassCoefficients(
  low: number = filterConfig.bandpassLow,
  high: number = filterConfig.bandpassHigh,
  sampleRate: number = streamingConfig.sampleRate
): Coefficients {
  const key = `${low}-${high}@${sampleRate}`;
  const coefficients = BANDPASS_TABLE[key];

  if (!coefficients) {
    throw new AppError(
      `No precomputed bandpass section for "${key}". Available: ` +
        `${Object.keys(BANDPASS_TABLE).join(', ')}. Add one by running ` +
        'scipy.signal.butter(2, [low, high], btype="band", fs=rate).',
      500
    );
  }

  return coefficients;
}

/**
 * Resolve the configured notch coefficients.
 */
export function getNotchCoefficients(): Coefficients {
  const key = `${filterConfig.notchFreq}@${streamingConfig.sampleRate}`;
  const coefficients = NOTCH_TABLE[key];

  if (!coefficients) {
    throw new AppError(
      `No precomputed notch section for "${key}". Available: ` +
        `${Object.keys(NOTCH_TABLE).join(', ')}.`,
      500
    );
  }

  return coefficients;
}

/**
 * Direct-form II transposed IIR, matching scipy.signal.lfilter.
 *
 * The delay line is returned alongside the output so the caller can thread it
 * into the next call. This matters: packets arrive every 40 ms and a filter
 * restarted from zero on each one would ring at every packet boundary and
 * inject transients the classifier reads as signal.
 *
 * @param x - Input samples.
 * @param B - Numerator coefficients.
 * @param A - Denominator coefficients (A[0] is assumed to be 1).
 * @param state - Delay line from the previous call, or null to start fresh.
 * @returns The filtered samples and the updated delay line.
 */
export function applyIIR(
  x: number[],
  B: number[],
  A: number[],
  state: Float64Array | null
): [number[], Float64Array] {
  const ord = B.length - 1;
  const zi: Float64Array = state ?? new Float64Array(ord);
  const y: number[] = new Array(x.length);

  // An order-0 section has no delay line, so the loop below would read zi[0]
  // out of bounds and propagate NaN through the whole signal.
  if (ord === 0) {
    return [x.map((sample) => B[0] * sample), zi];
  }

  for (let n = 0; n < x.length; n++) {
    y[n] = B[0] * x[n] + zi[0];
    for (let k = 0; k < ord - 1; k++) {
      zi[k] = B[k + 1] * x[n] - A[k + 1] * y[n] + zi[k + 1];
    }
    zi[ord - 1] = B[ord] * x[n] - A[ord] * y[n];
  }

  return [y, zi];
}

/**
 * Bandpass a channel using the configured band.
 * @param x - Input samples.
 * @param state - Delay line from the previous packet on this channel.
 */
export function bandpassFilter(
  x: number[],
  state?: Float64Array | null,
  band?: { low: number; high: number }
): [number[], Float64Array] {
  const { b, a } = band
    ? getBandpassCoefficients(band.low, band.high)
    : getBandpassCoefficients();
  return applyIIR(x, b, a, state ?? null);
}

/**
 * Notch a channel at the configured mains frequency.
 * @param x - Input samples.
 * @param state - Delay line from the previous packet on this channel.
 */
export function notchFilter(
  x: number[],
  state?: Float64Array | null
): [number[], Float64Array] {
  const { b, a } = getNotchCoefficients();
  return applyIIR(x, b, a, state ?? null);
}
