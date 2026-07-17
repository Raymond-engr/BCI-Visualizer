import dotenv from 'dotenv';

dotenv.config();

import fs from 'fs';
import { loadReferenceDataset } from '../Datasets/services/datasetLoader.service';
import { referenceDatasetPath, streamingConfig } from '../config/streaming';
import { CUE_CODES } from '../Streaming/services/packet.service';
import logger from '../utils/logger';

/**
 * Verify the recording that backs simulation mode.
 *
 * Simulation mode is the demo path, so a missing or unparseable reference file
 * is the failure most likely to be discovered in front of an audience. This
 * script surfaces it at deploy time instead:
 *   npm run verify:reference
 */
const verify = async (): Promise<void> => {
  try {
    logger.info(`Reference dataset: ${referenceDatasetPath}`);

    if (!fs.existsSync(referenceDatasetPath)) {
      logger.error('File not found. Set REFERENCE_DATASET_PATH in .env');
      process.exit(1);
    }

    const started = Date.now();
    const { samples, channelNames, sampleRate, events } =
      loadReferenceDataset();
    const elapsed = Date.now() - started;

    const duration = samples[0].length / sampleRate;
    const cues = events.filter((event) => CUE_CODES[event.typeCode]);

    logger.info(`Parsed in ${elapsed} ms`);
    logger.info(
      `  Channels:    ${channelNames.length} (${channelNames.join(', ')})`
    );
    logger.info(`  Sample rate: ${sampleRate} Hz`);
    logger.info(`  Duration:    ${duration.toFixed(1)} s`);
    logger.info(`  Events:      ${events.length} (${cues.length} usable cues)`);

    if (sampleRate !== streamingConfig.sampleRate) {
      logger.warn(
        `Recording is ${sampleRate} Hz but SAMPLE_RATE is ` +
          `${streamingConfig.sampleRate} Hz. Filter coefficients are computed for ` +
          'the configured rate and will not match this file.'
      );
    }

    if (!cues.length) {
      logger.warn(
        'No left/right/feet cues found. Simulation will stream, but sessions ' +
          'will report no accuracy.'
      );
    }

    const flat = samples.filter((channel) =>
      channel.every((v) => v === channel[0])
    );
    if (flat.length) {
      logger.warn(`${flat.length} channel(s) are constant — check the montage`);
    }

    logger.info('Reference dataset is usable');
    process.exit(0);
  } catch (error: any) {
    logger.error(`Verification failed: ${error.message}`);
    process.exit(1);
  }
};

verify();
