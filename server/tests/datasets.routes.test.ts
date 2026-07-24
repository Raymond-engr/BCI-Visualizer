import fs from 'fs';
import path from 'path';
import request from 'supertest';
import mongoose from 'mongoose';
import {
  app,
  bearer,
  clearTestDb,
  seedUser,
  startTestDb,
  stopTestDb,
} from './helpers/api';
import Dataset, { DatasetStatus } from '../src/Datasets/models/dataset.model';
import { channelOrder } from '../src/utils/montage';

/**
 * middleware/uploadDataset resolves multer's destination once, at module load,
 * from UPLOADS_DIR — which tests/setup.ts points at an OS temp directory. Every
 * attachment below lands here, so the whole tree is removed once the file ends
 * rather than tracked upload by upload.
 */
const uploadsDir = path.resolve(process.env.UPLOADS_DIR as string);

/**
 * Recordings are built in memory and attached as buffers. A01T.gdf is not in the
 * repo, and a fixture committed to the source tree would have to be regenerated
 * by hand every time the montage changed.
 *
 * alignToMontage requires every one of the 22 montage channels, so the default
 * header is channelOrder itself; cases that exercise rejection narrow it.
 */
const buildCsv = ({
  channels = channelOrder,
  rows = 12,
  timeColumn = true,
  intervalSeconds = 1 / 250,
}: {
  channels?: string[];
  rows?: number;
  timeColumn?: boolean;
  intervalSeconds?: number;
} = {}): Buffer => {
  const header = [...(timeColumn ? ['time'] : []), ...channels];
  const lines = [header.join(',')];

  for (let r = 0; r < rows; r++) {
    const values = channels.map((_, c) =>
      (Math.sin((r + c) / 4) * 12).toFixed(4)
    );
    lines.push(
      [
        ...(timeColumn ? [(r * intervalSeconds).toFixed(6)] : []),
        ...values,
      ].join(',')
    );
  }

  return Buffer.from(lines.join('\n'), 'utf8');
};

const upload = (
  token: string,
  file: Buffer,
  filename: string,
  fields: Record<string, string> = {}
): request.Test => {
  const test = request(app)
    .post('/api/v1/datasets/upload')
    .set('Authorization', bearer(token));

  Object.entries(fields).forEach(([name, value]) => test.field(name, value));

  return test.attach('file', file, filename);
};

/** A dataset row that never came from an upload, for cases about querying. */
const seedDataset = (
  userId: mongoose.Types.ObjectId | unknown,
  overrides: Record<string, unknown> = {}
) =>
  Dataset.create({
    userId,
    originalName: 'prior-upload.csv',
    storedName: 'prior-upload-1.csv',
    filePath: path.join(uploadsDir, 'prior-upload-1.csv'),
    format: 'csv',
    sizeBytes: 2048,
    status: DatasetStatus.PARSED,
    ...overrides,
  });

const seedSecondUser = () =>
  seedUser({ name: 'Other Researcher', email: 'other@example.com' });

beforeAll(startTestDb);
afterEach(clearTestDb);
afterAll(stopTestDb);

// Attachments outlive clearTestDb, which only empties collections.
afterAll(() => {
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

describe('POST /api/v1/datasets/upload', () => {
  it('stores a CSV recording and returns the metadata read from it', async () => {
    const { accessToken } = await seedUser();

    const res = await upload(accessToken, buildCsv(), 'session-one.csv');

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      message: 'Dataset uploaded successfully',
    });
    expect(res.body.data).toMatchObject({
      originalName: 'session-one.csv',
      format: 'csv',
      status: 'parsed',
      channelCount: 22,
      sampleRate: 250,
      sampleCount: 12,
      eventCount: 0,
    });
  });

  /**
   * The upload is parsed synchronously precisely so that the channel table is
   * known before a session can select the file. Order matters as much as
   * membership: feature extraction indexes into the epoch by position.
   */
  it('reorders the channels into the canonical montage order', async () => {
    const { accessToken } = await seedUser();
    const shuffled = [...channelOrder].reverse();

    const res = await upload(
      accessToken,
      buildCsv({ channels: shuffled }),
      'reversed.csv'
    );

    expect(res.status).toBe(201);
    expect(res.body.data.channelNames).toEqual(channelOrder);
  });

  it('writes the recording to the uploads directory', async () => {
    const { accessToken } = await seedUser();

    const res = await upload(accessToken, buildCsv(), 'on-disk.csv');

    const stored = await Dataset.findById(res.body.data._id);
    expect(fs.existsSync(stored!.filePath)).toBe(true);
    expect(path.dirname(stored!.filePath)).toBe(uploadsDir);
  });

  it('records the subject the recording belongs to', async () => {
    const { accessToken } = await seedUser();

    const res = await upload(accessToken, buildCsv(), 'subject.csv', {
      subjectId: 's1',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.subjectId).toBe('s1');
  });

  it('leaves subjectId unset when the upload does not name one', async () => {
    const { accessToken } = await seedUser();

    const res = await upload(accessToken, buildCsv(), 'anonymous.csv');

    expect(res.body.data.subjectId).toBeUndefined();
  });

  /**
   * The rate is read from the time column rather than assumed, so a file
   * recorded on other hardware is not silently replayed at the wrong speed.
   */
  it('infers the sample rate from the time column', async () => {
    const { accessToken } = await seedUser();

    const res = await upload(
      accessToken,
      buildCsv({ intervalSeconds: 1 / 100 }),
      'hundred-hz.csv'
    );

    expect(res.body.data.sampleRate).toBe(100);
    expect(res.body.data.durationSeconds).toBeCloseTo(12 / 100);
  });

  it('falls back to the configured rate when the file has no timestamps', async () => {
    const { accessToken } = await seedUser();

    const res = await upload(
      accessToken,
      buildCsv({ timeColumn: false }),
      'no-time.csv'
    );

    expect(res.status).toBe(201);
    expect(res.body.data.sampleRate).toBe(250);
  });

  it('rejects a recording that was truncated mid-row', async () => {
    const { accessToken } = await seedUser();
    const truncated = Buffer.from(
      `${buildCsv().toString('utf8')}\n0.048000,1.0,2.0`,
      'utf8'
    );

    const res = await upload(accessToken, truncated, 'truncated.csv');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^Recording could not be read: /);
  });

  it('rejects a file that is not a recording at all', async () => {
    const { accessToken } = await seedUser();
    const garbage = Buffer.from([
      0x00, 0xff, 0x1f, 0x8b, 0x08, 0x00, 0x42, 0x91, 0xde, 0xad, 0xbe, 0xef,
    ]);

    const res = await upload(accessToken, garbage, 'garbage.csv');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^Recording could not be read: /);
  });

  it('rejects a CSV with a header but no samples', async () => {
    const { accessToken } = await seedUser();

    const res = await upload(
      accessToken,
      buildCsv({ rows: 0 }),
      'header-only.csv'
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(
      'Recording could not be read: CSV file contains no data rows'
    );
  });

  it('rejects a recording that is missing montage channels', async () => {
    const { accessToken } = await seedUser();

    const res = await upload(
      accessToken,
      buildCsv({ channels: channelOrder.slice(0, 20) }),
      'short-montage.csv'
    );

    expect(res.status).toBe(400);
    // The electrodes are named, not just counted — the user has to know which
    // ones their export left out.
    expect(res.body.message).toBe(
      'Recording could not be read: Recording is missing 2 required ' +
        'channel(s): P2, POz'
    );
  });

  /**
   * A file that cannot be read is still kept, so the settings page can show the
   * user why it was turned away — but it must never be selectable for a session.
   */
  it('keeps a rejected recording, marked invalid, with the reason', async () => {
    const { accessToken } = await seedUser();

    await upload(accessToken, buildCsv({ rows: 0 }), 'header-only.csv');

    const stored = await Dataset.findOne({ originalName: 'header-only.csv' });
    expect(stored!.status).toBe('invalid');
    expect(stored!.parseError).toBe('CSV file contains no data rows');
    expect(stored!.channelCount).toBeUndefined();
  });

  it('rejects a file type the pipeline has no reader for', async () => {
    const { accessToken } = await seedUser();

    const res = await upload(
      accessToken,
      Buffer.from('some notes', 'utf8'),
      'notes.txt'
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(
      'Unsupported file type ".txt". Upload a GDF or CSV recording.'
    );
    expect(await Dataset.countDocuments()).toBe(0);
  });

  it('rejects a request that carries no file', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .post('/api/v1/datasets/upload')
      .set('Authorization', bearer(accessToken))
      .field('subjectId', 's1');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('No file was uploaded');
  });

  it('rejects an unauthenticated upload', async () => {
    const res = await request(app)
      .post('/api/v1/datasets/upload')
      .attach('file', buildCsv(), 'session-one.csv');

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Access token required');
  });
});

describe('GET /api/v1/datasets', () => {
  it('lists the uploads newest first', async () => {
    const { user, accessToken } = await seedUser();
    await seedDataset(user._id, {
      originalName: 'older.csv',
      createdAt: new Date('2026-01-01T10:00:00Z'),
    });
    await seedDataset(user._id, {
      originalName: 'newer.csv',
      createdAt: new Date('2026-02-01T10:00:00Z'),
    });

    const res = await request(app)
      .get('/api/v1/datasets')
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Datasets retrieved successfully');
    expect(
      res.body.data.map((d: { originalName: string }) => d.originalName)
    ).toEqual([
      'newer.csv',
      'older.csv',
    ]);
  });

  it('returns an empty list before anything has been uploaded', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .get('/api/v1/datasets')
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  /** The absolute server path is of no use to a client and worth not leaking. */
  it('never exposes where the recording is stored on the server', async () => {
    const { user, accessToken } = await seedUser();
    await seedDataset(user._id);

    const res = await request(app)
      .get('/api/v1/datasets')
      .set('Authorization', bearer(accessToken));

    expect(res.body.data[0]).not.toHaveProperty('filePath');
    expect(res.body.data[0].storedName).toBe('prior-upload-1.csv');
  });

  it('omits recordings uploaded by another user', async () => {
    const { user, accessToken } = await seedUser();
    const { user: other } = await seedSecondUser();
    await seedDataset(user._id, { originalName: 'mine.csv' });
    await seedDataset(other._id, { originalName: 'theirs.csv' });

    const res = await request(app)
      .get('/api/v1/datasets')
      .set('Authorization', bearer(accessToken));

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].originalName).toBe('mine.csv');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/datasets');

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Access token required');
  });
});

describe('GET /api/v1/datasets/:datasetId', () => {
  it("returns one of the caller's uploads", async () => {
    const { user, accessToken } = await seedUser();
    const dataset = await seedDataset(user._id, { originalName: 'wanted.csv' });

    const res = await request(app)
      .get(`/api/v1/datasets/${dataset._id}`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Dataset retrieved successfully');
    expect(res.body.data).toMatchObject({
      _id: String(dataset._id),
      originalName: 'wanted.csv',
      status: 'parsed',
    });
    expect(res.body.data).not.toHaveProperty('filePath');
  });

  it('rejects an id that is not an object id', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .get('/api/v1/datasets/not-an-id')
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid dataset ID format');
  });

  it('reports an id that matches no recording', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .get(`/api/v1/datasets/${new mongoose.Types.ObjectId()}`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Dataset not found');
  });

  it("refuses to read another user's recording", async () => {
    const { accessToken } = await seedUser();
    const { user: other } = await seedSecondUser();
    const dataset = await seedDataset(other._id);

    const res = await request(app)
      .get(`/api/v1/datasets/${dataset._id}`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This dataset belongs to another user');
  });

  it('rejects an unauthenticated request', async () => {
    const { user } = await seedUser();
    const dataset = await seedDataset(user._id);

    const res = await request(app).get(`/api/v1/datasets/${dataset._id}`);

    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/v1/datasets/:datasetId', () => {
  it('removes the record and the file backing it', async () => {
    const { accessToken } = await seedUser();
    const uploaded = await upload(accessToken, buildCsv(), 'to-delete.csv');
    const stored = await Dataset.findById(uploaded.body.data._id);
    const filePath = stored!.filePath;
    expect(fs.existsSync(filePath)).toBe(true);

    const res = await request(app)
      .delete(`/api/v1/datasets/${stored!._id}`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Dataset deleted successfully');
    expect(await Dataset.findById(stored!._id)).toBeNull();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  /**
   * A dataset row can outlive the file it points at — an operator clearing the
   * uploads volume, say. Deleting the record should still succeed.
   */
  it('deletes the record when the file is already gone', async () => {
    const { user, accessToken } = await seedUser();
    const dataset = await seedDataset(user._id, {
      filePath: path.join(uploadsDir, 'never-written.csv'),
    });

    const res = await request(app)
      .delete(`/api/v1/datasets/${dataset._id}`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(await Dataset.findById(dataset._id)).toBeNull();
  });

  it("refuses to delete another user's recording, and leaves it intact", async () => {
    const { accessToken } = await seedUser();
    const { user: other } = await seedSecondUser();
    const dataset = await seedDataset(other._id);

    const res = await request(app)
      .delete(`/api/v1/datasets/${dataset._id}`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This dataset belongs to another user');
    expect(await Dataset.findById(dataset._id)).not.toBeNull();
  });

  it('reports an id that matches no recording', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .delete(`/api/v1/datasets/${new mongoose.Types.ObjectId()}`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Dataset not found');
  });

  it('rejects an id that is not an object id', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .delete('/api/v1/datasets/not-an-id')
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid dataset ID format');
  });

  it('rejects an unauthenticated request', async () => {
    const { user } = await seedUser();
    const dataset = await seedDataset(user._id);

    const res = await request(app).delete(`/api/v1/datasets/${dataset._id}`);

    expect(res.status).toBe(401);
    expect(await Dataset.findById(dataset._id)).not.toBeNull();
  });
});
