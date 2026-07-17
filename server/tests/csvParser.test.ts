import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseCSVFile } from '../src/Datasets/services/csvParser.service';

let tmpDir: string;

const writeCSV = (name: string, content: string): string => {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
};

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bci-csv-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('csvParser.service', () => {
  it('reads channel labels from the header row', () => {
    const file = writeCSV('basic.csv', 'C3,Cz,C4\n1,2,3\n4,5,6\n7,8,9\n');
    expect(parseCSVFile(file).channelNames).toEqual(['C3', 'Cz', 'C4']);
  });

  it('returns samples channel-major, not row-major', () => {
    const file = writeCSV('shape.csv', 'C3,Cz\n1,10\n2,20\n3,30\n');
    const { samples } = parseCSVFile(file);
    expect(samples).toHaveLength(2);
    expect(samples[0]).toEqual([1, 2, 3]);
    expect(samples[1]).toEqual([10, 20, 30]);
  });

  it('infers the sample rate from a time column', () => {
    const rows = Array.from(
      { length: 10 },
      (_, i) => `${(i * 0.004).toFixed(3)},1,2`
    ).join('\n');
    const file = writeCSV('timed.csv', `time,C3,Cz\n${rows}\n`);
    // 4 ms between samples is 250 Hz.
    expect(parseCSVFile(file).sampleRate).toBeCloseTo(250, 0);
  });

  it('discards the time column rather than treating it as an electrode', () => {
    const file = writeCSV('drop.csv', 'time,C3,Cz\n0.000,1,2\n0.004,3,4\n');
    const recording = parseCSVFile(file);
    expect(recording.channelNames).toEqual(['C3', 'Cz']);
    expect(recording.samples).toHaveLength(2);
  });

  it('falls back to the configured rate when there is no time column', () => {
    const file = writeCSV('untimed.csv', 'C3,Cz\n1,2\n3,4\n');
    expect(parseCSVFile(file).sampleRate).toBe(250);
  });

  it('computes duration from sample count and rate', () => {
    const rows = Array.from({ length: 500 }, () => '1,2').join('\n');
    const file = writeCSV('duration.csv', `C3,Cz\n${rows}\n`);
    // 500 samples at 250 Hz is two seconds.
    expect(parseCSVFile(file).durationSeconds).toBeCloseTo(2, 3);
  });

  it('carries no events, since CSV has nowhere to put them', () => {
    const file = writeCSV('events.csv', 'C3\n1\n2\n');
    expect(parseCSVFile(file).events).toEqual([]);
  });

  it('rejects a file with no data rows', () => {
    const file = writeCSV('empty.csv', 'C3,Cz\n');
    expect(() => parseCSVFile(file)).toThrow();
  });

  it('rejects a completely empty file', () => {
    const file = writeCSV('blank.csv', '');
    expect(() => parseCSVFile(file)).toThrow();
  });

  it('tolerates whitespace around header labels', () => {
    const file = writeCSV('spaced.csv', ' C3 , Cz \n1,2\n3,4\n');
    expect(parseCSVFile(file).channelNames).toEqual(['C3', 'Cz']);
  });

  it('handles a trailing newline without emitting an empty sample', () => {
    const file = writeCSV('trailing.csv', 'C3\n1\n2\n3\n\n');
    expect(parseCSVFile(file).samples[0]).toEqual([1, 2, 3]);
  });
});
