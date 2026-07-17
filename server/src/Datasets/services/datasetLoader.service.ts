import fs from 'fs';
import path from 'path';
import { parseGDFFile, ParsedRecording } from './gdfParser.service';
import { parseCSVFile } from './csvParser.service';
import { referenceDatasetPath } from '../../config/streaming';
import { channelOrder, reconcileChannels } from '../../utils/montage';
import { BadRequestError, NotFoundError } from '../../utils/customErrors';
import logger from '../../utils/logger';

/**
 * Read a recording from disk, dispatching on file extension.
 * @param filePath - Absolute path to the recording.
 * @returns The decoded recording.
 */
export function loadRecording(filePath: string): ParsedRecording {
  if (!fs.existsSync(filePath)) {
    throw new NotFoundError(`Recording not found at ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case '.gdf':
      return parseGDFFile(filePath);
    case '.csv':
      return parseCSVFile(filePath);
    default:
      throw new BadRequestError(`Unsupported recording format "${ext}"`);
  }
}

/**
 * Reduce a recording to exactly the montage channels, in canonical order.
 * Uploaded files routinely carry EOG channels and store the strip in a
 * different order than the CSP filters expect, so this is applied before any
 * recording reaches the signal pipeline.
 * @param recording - A decoded recording.
 * @returns Samples and labels restricted to the montage.
 */
export function alignToMontage(recording: ParsedRecording): {
  samples: number[][];
  channelNames: string[];
  sampleRate: number;
} {
  const { compatible, missing } = reconcileChannels(recording.channelNames);

  if (!compatible) {
    throw new BadRequestError(
      `Recording is missing ${missing.length} required channel(s): ` +
        `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`
    );
  }

  const samples = channelOrder.map((label) => {
    const index = recording.channelNames.indexOf(label);
    return recording.samples[index];
  });

  return {
    samples,
    channelNames: [...channelOrder],
    sampleRate: recording.sampleRate,
  };
}

let referenceCache: ParsedRecording | null = null;

/**
 * Load the dataset replayed in simulation mode. Parsing a full BCICIV_2a
 * recording takes a few hundred milliseconds and the file never changes at
 * runtime, so the result is held in memory and shared across sessions.
 * @returns The reference recording, aligned to the montage.
 */
export function loadReferenceDataset(): {
  samples: number[][];
  channelNames: string[];
  sampleRate: number;
  events: ParsedRecording['events'];
} {
  if (!referenceCache) {
    if (!fs.existsSync(referenceDatasetPath)) {
      throw new NotFoundError(
        `Reference dataset not found at ${referenceDatasetPath}. ` +
          'Set REFERENCE_DATASET_PATH or run "npm run seed:reference".'
      );
    }

    logger.info(`Loading reference dataset from ${referenceDatasetPath}`);
    referenceCache = loadRecording(referenceDatasetPath);
  }

  const aligned = alignToMontage(referenceCache);
  return { ...aligned, events: referenceCache.events };
}

/**
 * Drop the cached reference recording. Used by tests and by the seed script.
 */
export function clearReferenceCache(): void {
  referenceCache = null;
}

export default loadRecording;
