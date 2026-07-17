import path from 'path';
import logger from '../utils/logger';

/**
 * Every timing constant in the streaming pipeline derives from the acquisition
 * rate, so it is resolved once here rather than being hard-coded per module.
 */
const SAMPLE_RATE = Number(process.env.SAMPLE_RATE || 250);

export const streamingConfig = {
  /** Acquisition rate in Hz. */
  sampleRate: SAMPLE_RATE,

  /** Samples per epoch — 4 s @ 250 Hz. Matches the training window. */
  epochSamples: SAMPLE_RATE * 4,

  /** Samples the buffer advances per epoch — 1 s step, 75% overlap. */
  stepSamples: SAMPLE_RATE * 1,

  /** Samples per outbound DATA_PACKET. */
  packetSamples: 10,

  /** Milliseconds between packets in simulation mode, i.e. real-time replay. */
  get packetIntervalMs(): number {
    return Math.round((1000 * this.packetSamples) / this.sampleRate);
  },

  /** Rolling window the frontend renders, in samples (8 s @ 250 Hz). */
  windowSamples: SAMPLE_RATE * 8,

  /** Welch PSD segment length, in samples. */
  welchSegment: 256,

  /** Idle sockets are closed after this long without a client pong. */
  heartbeatMs: 30_000,
};

export const filterConfig = {
  bandpassLow: Number(process.env.BANDPASS_LOW || 8),
  bandpassHigh: Number(process.env.BANDPASS_HIGH || 30),
  notchFreq: Number(process.env.NOTCH_FREQ || 50),
};

export const classifierConfig = {
  modelDir: path.resolve(process.env.MODEL_DIR || './models'),
  defaultModelId: process.env.DEFAULT_MODEL_ID || 'global',
  useMLService: process.env.USE_ML_SERVICE === 'true',
  mlServiceUrl: process.env.ML_SERVICE_URL || 'http://localhost:8000',
  labels: ['left_hand', 'right_hand', 'feet'] as const,
};

export const uploadConfig = {
  dir: process.env.UPLOADS_DIR || 'src/uploads/datasets',
  maxBytes: Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024,
  allowedExtensions: ['.gdf', '.csv'],
};

export const referenceDatasetPath = path.resolve(
  process.env.REFERENCE_DATASET_PATH || './models/A01T.gdf'
);

export const logStreamingConfig = (): void => {
  logger.info(
    `Streaming configured: ${streamingConfig.sampleRate} Hz, ` +
      `${streamingConfig.epochSamples}-sample epochs, ` +
      `${streamingConfig.stepSamples}-sample step, ` +
      `bandpass ${filterConfig.bandpassLow}-${filterConfig.bandpassHigh} Hz, ` +
      `notch ${filterConfig.notchFreq} Hz`
  );
  logger.info(
    `Inference backend: ${
      classifierConfig.useMLService
        ? `ML service at ${classifierConfig.mlServiceUrl}`
        : `local ONNX (${classifierConfig.modelDir})`
    }`
  );
};

export default streamingConfig;
