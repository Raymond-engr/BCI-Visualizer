import { MILabel } from '../../Classification/models/classification.model';
import type { ClassificationResult } from '../../Classification/services/onnxClassifier.service';
import type { ProcessedPacket } from '../../Signal_Processing/services/signalProcessor.service';

export type StatusCode = 'STARTED' | 'COMPLETED' | 'ERROR' | 'APPLIED'; // Acknowledges a CONTROL frame

/**
 * One packet on the wire.
 *
 * `samples` is present on every packet, at the packet rate. The analysis
 * fields — `psd`, `topographic`, `classification` — appear only on the packet
 * that closes an epoch, roughly once per second. They are optional rather than
 * duplicated onto every packet because they genuinely do not change in
 * between: repeating them 24 times would multiply frame size for no new
 * information. The client keeps the last value it saw and renders the waveform
 * continuously underneath.
 */
export interface DataPacket {
  type: 'DATA_PACKET';
  timestamp: number; // Unix seconds, or stream time for file-backed modes
  samples: number[][]; // [channel][sample], bandpassed and optionally notched
  channelNames: string[];
  psd?: { freqs: number[]; power: number[] };
  topographic?: Record<string, number>;
  classification?: {
    predictedClass: MILabel;
    confidence: number;
    allScores: Record<string, number>;
  };
  /** Index of the most recent completed epoch, or -1 before the first. */
  epochIndex: number;
}

/**
 * Everything the dashboard needs to lay itself out, sent once with STARTED so
 * the client does not have to hardcode the montage or the sample rate.
 */
export interface StreamConfig {
  mode: string;
  sampleRate: number;
  channelNames: string[];
  packetSamples: number;
  epochSamples: number;
  stepSamples: number;
  /** Playback rate relative to real time. 1 for live and simulated sources. */
  speed: number;
  labels: string[];
  filters: { bandpassLow: number; bandpassHigh: number; notch: boolean };
  /** False when the source carries no cue events, so accuracy is unavailable. */
  hasGroundTruth: boolean;
}

export interface StatusMessage {
  type: 'STATUS';
  status: StatusCode;
  message: string;
  sessionId?: string;
  config?: StreamConfig;
  /** Echoed after a CONTROL frame is applied. */
  filters?: { bandpassLow: number; bandpassHigh: number; notch: boolean };
}

export type OutboundMessage = DataPacket | StatusMessage;

/** Function every mode uses to write to its socket. */
export type Send = (data: OutboundMessage) => void;

/**
 * Assemble a DATA_PACKET.
 *
 * Sample values are rounded to three decimals. At 22 channels and 25 packets a
 * second the raw float representation is the dominant cost on the wire, and
 * sub-millivolt precision is well below what a 4px-tall waveform trace can
 * show.
 */
export function buildDataPacket(params: {
  samples: number[][];
  channelNames: string[];
  epochIndex: number;
  timestamp?: number;
  processed?: ProcessedPacket | null;
  classification?: ClassificationResult | null;
}): DataPacket {
  const { samples, channelNames, processed, classification, epochIndex } =
    params;

  const packet: DataPacket = {
    type: 'DATA_PACKET',
    timestamp: params.timestamp ?? Date.now() / 1000,
    samples: samples.map((channel) =>
      channel.map((value) => Number(value.toFixed(3)))
    ),
    channelNames,
    epochIndex,
  };

  if (processed) {
    packet.psd = {
      freqs: processed.psd.freqs,
      power: processed.psd.power.map((value) => Number(value.toFixed(4))),
    };
    packet.topographic = processed.topographic;
  }

  if (classification) {
    packet.classification = {
      predictedClass: classification.predictedClass,
      confidence: Number(classification.confidence.toFixed(4)),
      allScores: Object.fromEntries(
        Object.entries(classification.allScores).map(([k, v]) => [
          k,
          Number(v.toFixed(4)),
        ])
      ),
    };
  }

  return packet;
}

/**
 * Assemble a STATUS frame.
 */
export function buildStatus(
  status: StatusCode,
  message: string,
  sessionId?: string,
  extra?: Partial<Pick<StatusMessage, 'config' | 'filters'>>
): StatusMessage {
  return { type: 'STATUS', status, message, sessionId, ...extra };
}

/**
 * GDF cue codes used by BCI Competition IV Dataset 2a.
 *
 * The recordings also carry 772 (tongue), which is intentionally absent from
 * this map. Trials cued 772 therefore resolve to no true class, which excludes
 * them from the accuracy denominator instead of counting them as errors — the
 * model was never trained to predict them.
 */
export const CUE_CODES: Record<number, MILabel> = {
  769: MILabel.LEFT_HAND,
  770: MILabel.RIGHT_HAND,
  771: MILabel.FEET,
};

/**
 * Resolve the cue in force at a given sample.
 *
 * A cue labels the four seconds of imagery that follow it, so an epoch is
 * attributed to the most recent cue that started within one trial length of it.
 *
 * @param events - Cue events from the recording.
 * @param sampleIndex - Index of the epoch's final sample.
 * @param sampleRate - Acquisition rate in Hz.
 * @param trialSeconds - How long a cue's label remains in force.
 * @returns The true label, or undefined outside any trial.
 */
export function resolveTrueClass(
  events: { position: number; typeCode: number }[],
  sampleIndex: number,
  sampleRate: number,
  trialSeconds = 4
): MILabel | undefined {
  const window = trialSeconds * sampleRate;
  let match: MILabel | undefined;

  for (const event of events) {
    if (event.position > sampleIndex) break;
    const label = CUE_CODES[event.typeCode];
    if (label && sampleIndex - event.position <= window) {
      match = label;
    }
  }

  return match;
}
