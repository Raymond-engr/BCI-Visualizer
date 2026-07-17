import fs from 'fs';
import path from 'path';
import { classifierConfig, streamingConfig } from '../../config/streaming';
import { bands, channelOrder } from '../../utils/montage';
import { AppError } from '../../utils/customErrors';
import logger from '../../utils/logger';

export type PSD = { freqs: number[]; power: number[] };

/* ── FFT ──────────────────────────────────────────────────────────────── */

/**
 * In-place iterative radix-2 Cooley-Tukey FFT.
 * @param re - Real parts; overwritten with the real spectrum.
 * @param im - Imaginary parts; overwritten with the imaginary spectrum.
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) {
    throw new AppError(`FFT length must be a power of two, received ${n}`, 500);
  }

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;

    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;

      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;

        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;

        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Periodic Hann window of the given length. */
function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  }
  return w;
}

/* ── Spectral estimates ───────────────────────────────────────────────── */

/**
 * Welch's power spectral density estimate.
 *
 * Averaging periodograms over overlapping Hann-windowed segments trades
 * frequency resolution for variance, which is the right trade here: the panel
 * needs a readable Mu/Beta envelope updated four times a second, not a
 * high-resolution line spectrum.
 *
 * @param x - One channel of samples.
 * @param sampleRate - Acquisition rate in Hz.
 * @param segmentLength - Segment length in samples; must be a power of two.
 * @returns One-sided PSD in units²/Hz, truncated to the display range.
 */
export function welchPSD(
  x: number[],
  sampleRate: number = streamingConfig.sampleRate,
  segmentLength: number = streamingConfig.welchSegment
): PSD {
  const nfft = Math.min(segmentLength, 1 << Math.floor(Math.log2(x.length)));
  if (nfft < 8) {
    return { freqs: [], power: [] };
  }

  const step = nfft >> 1; // 50% overlap
  const window = hann(nfft);

  // Normalisation for a one-sided density estimate.
  let windowPower = 0;
  for (let i = 0; i < nfft; i++) windowPower += window[i] * window[i];
  const norm = 1 / (sampleRate * windowPower);

  const halfBins = nfft / 2 + 1;
  const accumulator = new Float64Array(halfBins);
  let segments = 0;

  for (let start = 0; start + nfft <= x.length; start += step) {
    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);

    // Detrend each segment; a DC or slow drift offset would otherwise leak
    // across the whole spectrum and swamp the Mu band.
    let mean = 0;
    for (let i = 0; i < nfft; i++) mean += x[start + i];
    mean /= nfft;

    for (let i = 0; i < nfft; i++) re[i] = (x[start + i] - mean) * window[i];

    fft(re, im);

    for (let k = 0; k < halfBins; k++) {
      const magnitude = re[k] * re[k] + im[k] * im[k];
      // Double the interior bins to fold negative frequencies back in.
      const scale = k === 0 || k === nfft / 2 ? 1 : 2;
      accumulator[k] += magnitude * norm * scale;
    }

    segments++;
  }

  if (!segments) return { freqs: [], power: [] };

  const freqs: number[] = [];
  const power: number[] = [];
  const maxFreq = 40; // The spectrum panel plots 0-40 Hz.

  for (let k = 0; k < halfBins; k++) {
    const f = (k * sampleRate) / nfft;
    if (f > maxFreq) break;
    freqs.push(Number(f.toFixed(3)));
    power.push(accumulator[k] / segments);
  }

  return { freqs, power };
}

/**
 * Integrate PSD power across a frequency band.
 * @param psd - A PSD estimate.
 * @param low - Lower edge in Hz, inclusive.
 * @param high - Upper edge in Hz, inclusive.
 * @returns Mean power density in the band.
 */
export function bandPower(psd: PSD, low: number, high: number): number {
  let sum = 0;
  let count = 0;

  psd.freqs.forEach((f, i) => {
    if (f >= low && f <= high) {
      sum += psd.power[i];
      count++;
    }
  });

  return count ? sum / count : 0;
}

/**
 * Per-electrode Mu-band power, which is what the scalp heatmap interpolates.
 *
 * Values are returned in decibels relative to the epoch's mean across
 * electrodes. Absolute microvolt² values vary by an order of magnitude between
 * subjects and sessions, so a fixed colour scale over raw power would render
 * most recordings as a flat field; a relative scale keeps the contralateral
 * ERD contrast visible regardless of overall signal amplitude.
 *
 * @param epoch - One epoch, indexed [channel][sample].
 * @param channelNames - Labels aligned to `epoch`.
 * @param sampleRate - Acquisition rate in Hz.
 * @returns Relative Mu power in dB, keyed by electrode label.
 */
export function computeTopographic(
  epoch: number[][],
  channelNames: string[],
  sampleRate: number = streamingConfig.sampleRate
): Record<string, number> {
  const raw: number[] = epoch.map((channel) =>
    bandPower(welchPSD(channel, sampleRate), bands.mu.low, bands.mu.high)
  );

  const mean = raw.reduce((sum, v) => sum + v, 0) / (raw.length || 1);
  const reference = mean > 0 ? mean : 1;

  const out: Record<string, number> = {};
  channelNames.forEach((label, i) => {
    const value = raw[i] > 0 ? raw[i] : Number.EPSILON;
    out[label] = Number((10 * Math.log10(value / reference)).toFixed(3));
  });

  return out;
}

/* ── CSP ──────────────────────────────────────────────────────────────── */

type CSPModel = {
  /** Spatial filters, shaped [components][channels]. */
  filters: number[][];
  /** Channel order the filters were fitted against. */
  channels?: string[];
};

const cspCache = new Map<string, CSPModel>();

/**
 * Load the CSP spatial filters exported alongside an ONNX model.
 *
 * CSP is fitted in Python but cannot be exported into the ONNX graph, so the
 * training pipeline writes the filter matrix out as JSON and it is applied here
 * before the feature vector reaches the model.
 *
 * @param modelId - Model identifier, e.g. "global" or "s1".
 * @returns The CSP model.
 */
export function loadCSPFilters(
  modelId: string = classifierConfig.defaultModelId
): CSPModel {
  const cached = cspCache.get(modelId);
  if (cached) return cached;

  const filePath = path.join(classifierConfig.modelDir, `csp_${modelId}.json`);

  if (!fs.existsSync(filePath)) {
    throw new AppError(
      `CSP filters not found at ${filePath}. Export them from the training ` +
        'pipeline before serving model "' +
        modelId +
        '".',
      500
    );
  }

  const model = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CSPModel;

  if (!Array.isArray(model.filters) || !model.filters.length) {
    throw new AppError(`CSP file ${filePath} contains no filters`, 500);
  }

  if (model.filters[0].length !== channelOrder.length) {
    throw new AppError(
      `CSP filters expect ${model.filters[0].length} channels but the montage ` +
        `has ${channelOrder.length}`,
      500
    );
  }

  cspCache.set(modelId, model);
  logger.info(
    `[CSP] Loaded ${model.filters.length} spatial filters for "${modelId}"`
  );

  return model;
}

/** Drop cached CSP filters. Used by tests and after a retrain. */
export function clearCSPCache(): void {
  cspCache.clear();
}

/**
 * Project an epoch through the CSP filters and reduce each component to its
 * log-variance.
 *
 * This mirrors MNE's `CSP.transform(..., transform_into='average_power',
 * log=True)`: project, take mean squared amplitude per component, take the log.
 * The log is what makes the feature roughly Gaussian, which is the assumption
 * the downstream LDA is built on.
 *
 * @param epoch - One epoch, indexed [channel][sample], in montage order.
 * @param modelId - Which CSP filter set to apply.
 * @returns One feature per CSP component.
 */
export function computeCSPFeatures(
  epoch: number[][],
  modelId: string = classifierConfig.defaultModelId
): number[] {
  const { filters } = loadCSPFilters(modelId);
  const samples = epoch[0]?.length ?? 0;

  if (!samples) return [];
  if (epoch.length !== filters[0].length) {
    throw new AppError(
      `Epoch has ${epoch.length} channels, CSP filters expect ${filters[0].length}`,
      500
    );
  }

  return filters.map((filter) => {
    // Accumulate the projected component's power in one pass; materialising
    // the projected signal first would allocate a full epoch per component.
    let power = 0;

    for (let s = 0; s < samples; s++) {
      let projected = 0;
      for (let c = 0; c < filter.length; c++) {
        projected += filter[c] * epoch[c][s];
      }
      power += projected * projected;
    }

    const meanPower = power / samples;
    return Math.log(meanPower > 0 ? meanPower : Number.EPSILON);
  });
}
