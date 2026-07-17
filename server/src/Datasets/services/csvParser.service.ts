import fs from 'fs';
import Papa from 'papaparse';
import { BadRequestError } from '../../utils/customErrors';
import { streamingConfig } from '../../config/streaming';
import logger from '../../utils/logger';
import type { ParsedRecording } from './gdfParser.service';

/**
 * CSV EEG reader.
 *
 * The expected shape is one column per electrode and one row per sample, with a
 * header row of channel labels. An optional leading `time`/`timestamp` column is
 * used to infer the sample rate and is then discarded.
 */
export function parseCSVFile(filePath: string): ParsedRecording {
  const text = fs.readFileSync(filePath, 'utf8');

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    transformHeader: (h) => h.trim(),
  });

  // Papa reports warnings and hard failures through the same array. A
  // single-column file legitimately has no delimiter to detect, and a ragged
  // final row is caught more precisely by the numeric check below, so neither
  // is grounds for rejecting the file.
  const fatal = parsed.errors.filter(
    (error) =>
      error.code !== 'UndetectableDelimiter' &&
      error.code !== 'TooFewFields' &&
      error.code !== 'TooManyFields'
  );

  if (fatal.length) {
    const first = fatal[0];
    throw new BadRequestError(
      `CSV parse failed on row ${first.row ?? '?'}: ${first.message}`
    );
  }

  if (parsed.errors.length > fatal.length) {
    logger.warn(
      `CSV parsed with ${parsed.errors.length - fatal.length} warning(s), ` +
        `first: ${parsed.errors[0].message}`
    );
  }

  const rows = parsed.data;
  if (!rows.length) {
    throw new BadRequestError('CSV file contains no data rows');
  }

  const allColumns = parsed.meta.fields ?? [];
  if (!allColumns.length) {
    throw new BadRequestError('CSV file is missing a header row');
  }

  const timeColumn = allColumns.find((c) => /^(time|timestamp)$/i.test(c));
  const channelNames = allColumns.filter((c) => c !== timeColumn);

  if (!channelNames.length) {
    throw new BadRequestError('CSV file contains no channel columns');
  }

  const samples: number[][] = channelNames.map(
    () => new Array<number>(rows.length)
  );

  rows.forEach((row, r) => {
    channelNames.forEach((name, c) => {
      const value = Number(row[name]);
      if (!Number.isFinite(value)) {
        throw new BadRequestError(
          `Non-numeric value "${row[name]}" in column "${name}" at row ${r + 2}`
        );
      }
      samples[c][r] = value;
    });
  });

  const sampleRate = inferSampleRate(rows, timeColumn);

  logger.info(
    `Parsed CSV: ${channelNames.length} channels, ${sampleRate} Hz, ` +
      `${rows.length} samples`
  );

  return {
    header: {
      version: 'CSV',
      majorVersion: 2,
      headerLengthBytes: 0,
      recordCount: rows.length,
      recordDurationSeconds: 1 / sampleRate,
      channelCount: channelNames.length,
      sampleRate,
      labels: channelNames,
      physicalDimensions: channelNames.map(() => 'uV'),
      physicalMin: channelNames.map(() => 0),
      physicalMax: channelNames.map(() => 0),
      digitalMin: channelNames.map(() => 0),
      digitalMax: channelNames.map(() => 0),
      samplesPerRecord: channelNames.map(() => 1),
      channelTypes: channelNames.map(() => 17),
    },
    samples,
    channelNames,
    sampleRate,
    durationSeconds: rows.length / sampleRate,
    events: [],
  };
}

/**
 * Derive the sample rate from the median inter-sample interval of the time
 * column, falling back to the configured acquisition rate when the file has no
 * usable timestamps.
 */
function inferSampleRate(
  rows: Record<string, string>[],
  timeColumn?: string
): number {
  if (!timeColumn || rows.length < 3) return streamingConfig.sampleRate;

  const deltas: number[] = [];
  for (let i = 1; i < Math.min(rows.length, 200); i++) {
    const previous = Number(rows[i - 1][timeColumn]);
    const current = Number(rows[i][timeColumn]);
    if (Number.isFinite(previous) && Number.isFinite(current)) {
      const delta = current - previous;
      if (delta > 0) deltas.push(delta);
    }
  }

  if (!deltas.length) return streamingConfig.sampleRate;

  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];

  // Timestamps may be in seconds or milliseconds; a median step above 0.02
  // would imply a rate below 50 Hz, which no supported montage uses.
  const rate = median > 0.02 ? 1000 / median : 1 / median;

  return Math.round(rate);
}

export default parseCSVFile;
