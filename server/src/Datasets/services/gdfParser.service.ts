import fs from 'fs';
import { BadRequestError } from '../../utils/customErrors';
import { channelOrder } from '../../utils/montage';
import logger from '../../utils/logger';

/**
 * GDF (General Data Format for biosignals) reader.
 *
 * Both GDF 1.x and GDF 2.x are supported. The two revisions differ in the
 * middle of the fixed header and in the layout of the per-channel variable
 * header, but they agree on the fields this parser needs from the tail of the
 * fixed header (NRec at 236, record duration at 244, channel count at 252), so
 * only the variable header requires a version branch.
 */

export type GdfHeader = {
  version: string;
  majorVersion: 1 | 2;
  headerLengthBytes: number;
  recordCount: number;
  recordDurationSeconds: number;
  channelCount: number;
  sampleRate: number;
  labels: string[];
  physicalDimensions: string[];
  physicalMin: number[];
  physicalMax: number[];
  digitalMin: number[];
  digitalMax: number[];
  samplesPerRecord: number[];
  channelTypes: number[];
};

export type GdfEvent = {
  position: number; // sample index
  typeCode: number;
  durationSamples?: number;
};

export type ParsedRecording = {
  header: GdfHeader;
  /** Physical-unit samples, indexed [channel][sample]. */
  samples: number[][];
  /** Labels aligned to `samples`, normalised against the 10-20 montage. */
  channelNames: string[];
  sampleRate: number;
  durationSeconds: number;
  events: GdfEvent[];
};

/** GDF numeric type codes mapped to byte width and a Buffer reader. */
const GDF_TYPES: Record<
  number,
  { bytes: number; read: (buf: Buffer, offset: number) => number }
> = {
  1: { bytes: 1, read: (b, o) => b.readInt8(o) },
  2: { bytes: 1, read: (b, o) => b.readUInt8(o) },
  3: { bytes: 2, read: (b, o) => b.readInt16LE(o) },
  4: { bytes: 2, read: (b, o) => b.readUInt16LE(o) },
  5: { bytes: 4, read: (b, o) => b.readInt32LE(o) },
  6: { bytes: 4, read: (b, o) => b.readUInt32LE(o) },
  7: { bytes: 8, read: (b, o) => Number(b.readBigInt64LE(o)) },
  8: { bytes: 8, read: (b, o) => Number(b.readBigUInt64LE(o)) },
  16: { bytes: 4, read: (b, o) => b.readFloatLE(o) },
  17: { bytes: 8, read: (b, o) => b.readDoubleLE(o) },
};

const ascii = (buf: Buffer, start: number, length: number): string =>
  buf
    .toString('ascii', start, start + length)
    .replace(/\0/g, '')
    .trim();

/**
 * Read the 256-byte fixed header plus the per-channel variable header.
 * @param buf - Buffer holding at least the full header of the recording.
 * @returns The decoded header.
 */
export function parseGDFHeader(buf: Buffer): GdfHeader {
  if (buf.length < 256) {
    throw new BadRequestError('File is too small to contain a GDF header');
  }

  const version = ascii(buf, 0, 8);
  if (!version.startsWith('GDF')) {
    throw new BadRequestError('Not a GDF file: missing GDF version magic');
  }

  const majorVersion: 1 | 2 = version.includes('2.') ? 2 : 1;

  // Header length: GDF 1.x stores a byte count as int64 at 184; GDF 2.x stores
  // a count of 256-byte blocks as uint16 at 184.
  const headerLengthBytes =
    majorVersion === 2
      ? buf.readUInt16LE(184) * 256
      : Number(buf.readBigInt64LE(184));

  // The tail of the fixed header is identical across both revisions.
  const recordCount = Number(buf.readBigInt64LE(236));
  const durNumerator = buf.readUInt32LE(244);
  const durDenominator = buf.readUInt32LE(248);
  const channelCount = buf.readUInt16LE(252);

  if (durDenominator === 0) {
    throw new BadRequestError('Corrupt GDF header: record duration is zero');
  }
  if (channelCount === 0 || channelCount > 512) {
    throw new BadRequestError(
      `Corrupt GDF header: implausible channel count (${channelCount})`
    );
  }

  const recordDurationSeconds = durNumerator / durDenominator;
  const ns = channelCount;
  const base = 256;

  if (buf.length < base + 256 * ns) {
    throw new BadRequestError('File is truncated: variable header incomplete');
  }

  const labels: string[] = [];
  for (let i = 0; i < ns; i++) {
    labels.push(ascii(buf, base + i * 16, 16));
  }

  const physicalDimensions: string[] = [];
  const physicalMin: number[] = [];
  const physicalMax: number[] = [];
  const digitalMin: number[] = [];
  const digitalMax: number[] = [];
  const samplesPerRecord: number[] = [];
  const channelTypes: number[] = [];

  if (majorVersion === 2) {
    // v2 layout: dim(6) dimCode(2) physMin(f64) physMax(f64) digMin(f64)
    //            digMax(f64) prefilt(80) lp(f32) hp(f32) notch(f32)
    //            SPR(u32) GDFTYP(u32) ...
    const oDim = base + 96 * ns;
    const oPhysMin = base + 104 * ns;
    const oPhysMax = base + 112 * ns;
    const oDigMin = base + 120 * ns;
    const oDigMax = base + 128 * ns;
    const oSpr = base + 228 * ns;
    const oTyp = base + 232 * ns;

    for (let i = 0; i < ns; i++) {
      physicalDimensions.push(ascii(buf, oDim + i * 6, 6));
      physicalMin.push(buf.readDoubleLE(oPhysMin + i * 8));
      physicalMax.push(buf.readDoubleLE(oPhysMax + i * 8));
      digitalMin.push(buf.readDoubleLE(oDigMin + i * 8));
      digitalMax.push(buf.readDoubleLE(oDigMax + i * 8));
      samplesPerRecord.push(buf.readUInt32LE(oSpr + i * 4));
      channelTypes.push(buf.readUInt32LE(oTyp + i * 4));
    }
  } else {
    // v1 layout: dim(8) physMin(f64) physMax(f64) digMin(i64) digMax(i64)
    //            prefilt(80) SPR(u32) GDFTYP(u32) reserved(32)
    const oDim = base + 96 * ns;
    const oPhysMin = base + 104 * ns;
    const oPhysMax = base + 112 * ns;
    const oDigMin = base + 120 * ns;
    const oDigMax = base + 128 * ns;
    const oSpr = base + 216 * ns;
    const oTyp = base + 220 * ns;

    for (let i = 0; i < ns; i++) {
      physicalDimensions.push(ascii(buf, oDim + i * 8, 8));
      physicalMin.push(buf.readDoubleLE(oPhysMin + i * 8));
      physicalMax.push(buf.readDoubleLE(oPhysMax + i * 8));
      digitalMin.push(Number(buf.readBigInt64LE(oDigMin + i * 8)));
      digitalMax.push(Number(buf.readBigInt64LE(oDigMax + i * 8)));
      samplesPerRecord.push(buf.readUInt32LE(oSpr + i * 4));
      channelTypes.push(buf.readUInt32LE(oTyp + i * 4));
    }
  }

  // Sample rate is per channel; the pipeline assumes a uniform rate, so the
  // first channel's SPR sets it and mismatches are rejected downstream.
  const sampleRate = samplesPerRecord[0] / recordDurationSeconds;

  return {
    version,
    majorVersion,
    headerLengthBytes: headerLengthBytes || base + 256 * ns,
    recordCount,
    recordDurationSeconds,
    channelCount,
    sampleRate,
    labels,
    physicalDimensions,
    physicalMin,
    physicalMax,
    digitalMin,
    digitalMax,
    samplesPerRecord,
    channelTypes,
  };
}

/**
 * Strip the BioSig channel-name decorations that BCI Competition IV 2a files
 * carry ("EEG-Fz", "EEG-0", "EOG-left") and align what remains to the canonical
 * montage. Channels whose labels are placeholders are resolved positionally,
 * which is how the reference dataset is laid out.
 * @param labels - Raw labels from the GDF header.
 * @returns Normalised labels, one per input channel; EOG channels keep their
 *          own names so the caller can drop them.
 */
export function normaliseLabels(labels: string[]): string[] {
  const cleaned = labels.map((l) => l.replace(/^EEG[-_]?/i, '').trim());
  const eegIndices: number[] = [];

  labels.forEach((l, i) => {
    if (!/^EOG/i.test(l)) eegIndices.push(i);
  });

  // When the file holds exactly as many EEG channels as the montage expects,
  // trust position over the label text — BioSig writes "EEG-0", "EEG-1" for
  // most of the strip.
  if (eegIndices.length === channelOrder.length) {
    const out = [...labels];
    eegIndices.forEach((fileIndex, montageIndex) => {
      out[fileIndex] = channelOrder[montageIndex];
    });
    return out;
  }

  return cleaned.map((c, i) => (c.length ? c : labels[i]));
}

/**
 * Decode every data record into physical units.
 * @param buf - Full file buffer.
 * @param header - Header previously decoded from the same buffer.
 * @returns Samples indexed [channel][sample].
 */
export function parseGDFSamples(buf: Buffer, header: GdfHeader): number[][] {
  const {
    channelCount: ns,
    samplesPerRecord,
    channelTypes,
    physicalMin,
    physicalMax,
    digitalMin,
    digitalMax,
    headerLengthBytes,
  } = header;

  const recordBytes = samplesPerRecord.reduce((sum, spr, i) => {
    const type = GDF_TYPES[channelTypes[i]];
    if (!type) {
      throw new BadRequestError(
        `Unsupported GDF channel type ${channelTypes[i]} on channel ${i + 1}`
      );
    }
    return sum + spr * type.bytes;
  }, 0);

  // NRec is -1 when the recording was not closed cleanly; derive it instead.
  const available = buf.length - headerLengthBytes;
  const recordCount =
    header.recordCount > 0
      ? Math.min(header.recordCount, Math.floor(available / recordBytes))
      : Math.floor(available / recordBytes);

  if (recordCount <= 0) {
    throw new BadRequestError('GDF file contains no readable data records');
  }

  if (header.recordCount > 0 && recordCount < header.recordCount) {
    logger.warn(
      `GDF file is truncated: header declares ${header.recordCount} records, ` +
        `only ${recordCount} are present. Reading what is available.`
    );
  }

  // Precompute the per-channel affine scaling from digital to physical units.
  const scale: number[] = [];
  const offset: number[] = [];
  for (let c = 0; c < ns; c++) {
    const digitalSpan = digitalMax[c] - digitalMin[c];
    const gain =
      digitalSpan === 0 ? 1 : (physicalMax[c] - physicalMin[c]) / digitalSpan;
    scale.push(gain);
    offset.push(physicalMin[c] - digitalMin[c] * gain);
  }

  const samples: number[][] = Array.from(
    { length: ns },
    (_, c) => new Array<number>(samplesPerRecord[c] * recordCount)
  );

  let cursor = headerLengthBytes;
  for (let r = 0; r < recordCount; r++) {
    for (let c = 0; c < ns; c++) {
      const type = GDF_TYPES[channelTypes[c]];
      const spr = samplesPerRecord[c];
      const out = samples[c];
      const writeBase = r * spr;

      for (let s = 0; s < spr; s++) {
        const raw = type.read(buf, cursor);
        out[writeBase + s] = raw * scale[c] + offset[c];
        cursor += type.bytes;
      }
    }
  }

  return samples;
}

/**
 * Read the GDF event table, which sits immediately after the data records and
 * carries the trial cue markers (769-772 = left hand, right hand, feet, tongue).
 * @param buf - Full file buffer.
 * @param header - Header previously decoded from the same buffer.
 * @returns The event list, empty when the file has no event table.
 */
export function parseGDFEvents(buf: Buffer, header: GdfHeader): GdfEvent[] {
  const recordBytes = header.samplesPerRecord.reduce((sum, spr, i) => {
    const type = GDF_TYPES[header.channelTypes[i]];
    return sum + spr * (type?.bytes ?? 0);
  }, 0);

  const recordCount =
    header.recordCount > 0
      ? header.recordCount
      : Math.floor((buf.length - header.headerLengthBytes) / recordBytes);

  const start = header.headerLengthBytes + recordCount * recordBytes;

  // The table header is 8 bytes: mode(1) + count(3) + sample rate(4).
  if (start + 8 > buf.length) return [];

  const mode = buf.readUInt8(start);
  const count =
    buf.readUInt8(start + 1) |
    (buf.readUInt8(start + 2) << 8) |
    (buf.readUInt8(start + 3) << 16);

  if (count <= 0) return [];

  const posStart = start + 8;
  const typStart = posStart + count * 4;
  if (typStart + count * 2 > buf.length) return [];

  const events: GdfEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push({
      position: buf.readUInt32LE(posStart + i * 4),
      typeCode: buf.readUInt16LE(typStart + i * 2),
    });
  }

  // Mode 3 additionally stores channel and duration columns.
  if (mode === 3) {
    const durStart = typStart + count * 2 + count * 2;
    if (durStart + count * 4 <= buf.length) {
      for (let i = 0; i < count; i++) {
        events[i].durationSamples = buf.readUInt32LE(durStart + i * 4);
      }
    }
  }

  return events;
}

/**
 * Read and decode a GDF recording from disk.
 * @param filePath - Absolute path to the .gdf file.
 * @returns The decoded recording.
 */
export function parseGDFFile(filePath: string): ParsedRecording {
  const buf = fs.readFileSync(filePath);
  const header = parseGDFHeader(buf);

  const uniformSpr = header.samplesPerRecord.every(
    (spr) => spr === header.samplesPerRecord[0]
  );
  if (!uniformSpr) {
    throw new BadRequestError(
      'Channels have differing sample rates; this pipeline requires a uniform rate'
    );
  }

  const samples = parseGDFSamples(buf, header);
  const events = parseGDFEvents(buf, header);
  const channelNames = normaliseLabels(header.labels);

  logger.info(
    `Parsed ${header.version}: ${header.channelCount} channels, ` +
      `${header.sampleRate} Hz, ${samples[0].length} samples, ` +
      `${events.length} events`
  );

  return {
    header,
    samples,
    channelNames,
    sampleRate: header.sampleRate,
    durationSeconds: samples[0].length / header.sampleRate,
    events,
  };
}

export default parseGDFFile;
