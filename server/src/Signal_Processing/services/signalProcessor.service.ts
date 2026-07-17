import { bandpassFilter, notchFilter } from './filters.service';
import { EpochBuffer } from './epoch.service';
import {
  computeCSPFeatures,
  welchPSD,
  computeTopographic,
  PSD,
} from './features.service';
import { getBandpassCoefficients } from './filters.service';
import { streamingConfig, filterConfig } from '../../config/streaming';
import { psdReferenceChannel } from '../../utils/montage';

export interface ProcessedPacket {
  features: number[];
  psd: PSD;
  topographic: Record<string, number>;
}

/**
 * The result of feeding one packet through the pipeline.
 *
 * `filtered` is produced for every packet; `analysis` only when the packet
 * completed an epoch. These are two different rates and must not be conflated:
 * the waveform needs samples at the packet rate (25 Hz), while classification
 * is inherently epoch-rate (1 Hz). Returning them together, with `analysis`
 * nullable, lets the caller emit the waveform continuously and attach the
 * analysis to whichever packet happens to close an epoch.
 */
export interface ProcessorOutput {
  filtered: number[][];
  analysis: ProcessedPacket | null;
}

export interface SignalProcessorOptions {
  modelId?: string;
  notch?: boolean;
  sampleRate?: number;
  bandpassLow?: number;
  bandpassHigh?: number;
}

/**
 * Per-session signal processing state.
 *
 * One instance exists per WebSocket session. It holds the filter delay lines
 * and the epoch buffer, both of which must persist across packets and must not
 * be shared between sessions — two clients streaming different recordings
 * through one processor would contaminate each other's filter state.
 */
export class SignalProcessor {
  private buffer: EpochBuffer | null = null;
  private bpStates: (Float64Array | null)[] = [];
  private notchStates: (Float64Array | null)[] = [];
  private readonly modelId?: string;
  private notchEnabled: boolean;
  private band: { low: number; high: number };
  private readonly sampleRate: number;

  constructor(options: SignalProcessorOptions = {}) {
    this.modelId = options.modelId;
    this.notchEnabled = options.notch ?? true;
    this.sampleRate = options.sampleRate ?? streamingConfig.sampleRate;
    this.band = {
      low: options.bandpassLow ?? filterConfig.bandpassLow,
      high: options.bandpassHigh ?? filterConfig.bandpassHigh,
    };
  }

  /** The filter settings currently in force. */
  get settings(): {
    bandpassLow: number;
    bandpassHigh: number;
    notch: boolean;
  } {
    return {
      bandpassLow: this.band.low,
      bandpassHigh: this.band.high,
      notch: this.notchEnabled,
    };
  }

  /**
   * Turn the mains notch on or off mid-session.
   *
   * The delay line is dropped rather than kept. A notch that has been off has
   * no meaningful state to resume from, and reusing a stale one would inject a
   * transient at the moment of the toggle.
   */
  setNotch(enabled: boolean): void {
    if (enabled === this.notchEnabled) return;
    this.notchEnabled = enabled;
    this.notchStates = [];
  }

  /**
   * Change the passband mid-session.
   *
   * Throws if no precomputed section exists for the requested band, which is
   * checked before any state is discarded so that a rejected change leaves the
   * processor exactly as it was.
   *
   * @param low - Lower cutoff in Hz.
   * @param high - Upper cutoff in Hz.
   */
  setBandpass(low: number, high: number): void {
    if (low === this.band.low && high === this.band.high) return;

    getBandpassCoefficients(low, high, this.sampleRate); // throws if absent

    this.band = { low, high };

    // The old delay line belongs to the old filter; carrying it into a
    // different transfer function would ring.
    this.bpStates = [];
  }

  /**
   * Filter one packet, accumulate it, and emit a feature set once a full epoch
   * is available.
   *
   * @param rawSamples - Incoming packet, indexed [channel][sample].
   * @param channelNames - Labels aligned to `rawSamples`, in montage order.
   * @returns The filtered samples, always, plus the feature set on the packet
   *          that completes an epoch and null on every other packet.
   */
  process(rawSamples: number[][], channelNames: string[]): ProcessorOutput {
    if (!rawSamples.length) return { filtered: [], analysis: null };

    if (!this.buffer) {
      this.buffer = new EpochBuffer(rawSamples.length);
    }

    // Per-channel filtering with state continuity across packets.
    const filtered = rawSamples.map((channel, i) => {
      const [bp, bpState] = bandpassFilter(
        channel,
        this.bpStates[i],
        this.band
      );
      this.bpStates[i] = bpState;

      if (!this.notchEnabled) return bp;

      const [notched, notchState] = notchFilter(bp, this.notchStates[i]);
      this.notchStates[i] = notchState;
      return notched;
    });

    this.buffer.push(filtered);

    const epoch = this.buffer.extract();
    if (!epoch) return { filtered, analysis: null };

    return { filtered, analysis: this.processEpoch(epoch, channelNames) };
  }

  /**
   * Process a complete epoch that has already been cut and filtered elsewhere.
   * Upload mode uses this, since it walks a whole file at once rather than
   * feeding packets through the ring buffer.
   */
  processEpoch(epoch: number[][], channelNames: string[]): ProcessedPacket {
    const psdIndex = Math.max(0, channelNames.indexOf(psdReferenceChannel));

    return {
      features: computeCSPFeatures(epoch, this.modelId),
      psd: welchPSD(epoch[psdIndex], this.sampleRate),
      topographic: computeTopographic(epoch, channelNames, this.sampleRate),
    };
  }

  /** Clear filter state and the epoch buffer. */
  reset(): void {
    this.buffer?.reset();
    this.bpStates = [];
    this.notchStates = [];
  }
}

export default SignalProcessor;
