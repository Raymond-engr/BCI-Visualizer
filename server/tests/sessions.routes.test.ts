import request from 'supertest';
import { Types } from 'mongoose';
import {
  app,
  bearer,
  clearTestDb,
  seedUser,
  startTestDb,
  stopTestDb,
} from './helpers/api';
import Session, {
  SessionMode,
  SessionStatus,
} from '../src/Sessions/models/session.model';
import Classification, {
  MILabel,
} from '../src/Classification/models/classification.model';
import Dataset, {
  DatasetFormat,
  DatasetStatus,
} from '../src/Datasets/models/dataset.model';
import type { IUser } from '../src/model/user.model';

/**
 * Two users with tokens. Ownership isolation is the whole point of this suite,
 * and every route under /sessions is authorised by comparing session.userId
 * against the caller — so almost every case needs a second identity to prove
 * the comparison is actually load-bearing.
 */
const seedOwnerAndIntruder = async () => {
  const owner = await seedUser({ email: 'owner@example.com' });
  const intruder = await seedUser({
    email: 'intruder@example.com',
    name: 'Mallory',
  });
  return { owner, intruder };
};

const createSession = (userId: unknown, overrides: Record<string, unknown> = {}) =>
  Session.create({
    userId,
    mode: SessionMode.SIMULATION,
    status: SessionStatus.PENDING,
    ...overrides,
  });

const createDataset = (userId: unknown, overrides: Record<string, unknown> = {}) =>
  Dataset.create({
    userId,
    originalName: 'A01T.gdf',
    storedName: 'stored-A01T.gdf',
    filePath: '/tmp/stored-A01T.gdf',
    format: DatasetFormat.GDF,
    sizeBytes: 1024,
    status: DatasetStatus.PARSED,
    ...overrides,
  });

/** An id that is well-formed but matches no document. */
const missingId = () => new Types.ObjectId().toString();

beforeAll(startTestDb);
afterEach(clearTestDb);
afterAll(stopTestDb);

describe('POST /api/v1/sessions', () => {
  it('reserves a pending simulation session for the caller', async () => {
    const { user, accessToken } = await seedUser();

    const res = await request(app)
      .post('/api/v1/sessions')
      .set('Authorization', bearer(accessToken))
      .send({ mode: SessionMode.SIMULATION });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      message: 'Session created successfully',
    });
    expect(res.body.data).toMatchObject({
      userId: String(user._id),
      mode: 'simulation',
      status: 'pending',
      epochCount: 0,
    });
  });

  /**
   * The socket handler rejects INIT for a session that is not `pending`, so a
   * newly created session arriving in any other status would make the stream
   * unopenable. The status is not client-supplied — pin it.
   */
  it('always creates the session pending, ignoring a status sent by the client', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .post('/api/v1/sessions')
      .set('Authorization', bearer(accessToken))
      .send({ mode: SessionMode.SIMULATION, status: SessionStatus.COMPLETED });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');

    const stored = await Session.findById(res.body.data._id);
    expect(stored!.status).toBe(SessionStatus.PENDING);
  });

  it('defaults modelId to the global model when none is named', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .post('/api/v1/sessions')
      .set('Authorization', bearer(accessToken))
      .send({ mode: SessionMode.SIMULATION });

    expect(res.body.data.modelId).toBe('global');
  });

  it('keeps a subject-specific modelId when one is named', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .post('/api/v1/sessions')
      .set('Authorization', bearer(accessToken))
      .send({ mode: SessionMode.SIMULATION, modelId: 's1' });

    expect(res.body.data.modelId).toBe('s1');
  });

  it('links the dataset when an upload session names one it owns', async () => {
    const { user, accessToken } = await seedUser();
    const dataset = await createDataset(user._id);

    const res = await request(app)
      .post('/api/v1/sessions')
      .set('Authorization', bearer(accessToken))
      .send({ mode: SessionMode.UPLOAD, datasetId: String(dataset._id) });

    expect(res.status).toBe(201);
    expect(res.body.data.datasetId).toBe(String(dataset._id));
    expect(res.body.data.mode).toBe('upload');
  });

  /**
   * datasetId is optional in the schema because two of the three modes have no
   * dataset. Only the controller can enforce it for uploads, so the rule needs
   * its own case rather than riding on validation.
   */
  it('rejects an upload session with no datasetId', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .post('/api/v1/sessions')
      .set('Authorization', bearer(accessToken))
      .send({ mode: SessionMode.UPLOAD });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Upload sessions require a datasetId');
    expect(await Session.countDocuments()).toBe(0);
  });

  it('rejects an upload session naming a dataset that does not exist', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .post('/api/v1/sessions')
      .set('Authorization', bearer(accessToken))
      .send({ mode: SessionMode.UPLOAD, datasetId: missingId() });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Dataset not found');
    expect(await Session.countDocuments()).toBe(0);
  });

  /**
   * Without this check a user could stream, classify and export any recording
   * in the system just by guessing a dataset id.
   */
  it('refuses to start a session on another user’s dataset', async () => {
    const { owner, intruder } = await seedOwnerAndIntruder();
    const dataset = await createDataset(owner.user._id);

    const res = await request(app)
      .post('/api/v1/sessions')
      .set('Authorization', bearer(intruder.accessToken))
      .send({ mode: SessionMode.UPLOAD, datasetId: String(dataset._id) });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This dataset belongs to another user');
    expect(await Session.countDocuments()).toBe(0);
  });

  /**
   * An unparsed dataset has no channel or sample metadata yet, so the stream
   * would fail well after the user thinks it started. Fail at creation instead.
   */
  it('rejects an upload session on a dataset that has not been parsed', async () => {
    const { user, accessToken } = await seedUser();
    const dataset = await createDataset(user._id, {
      status: DatasetStatus.UPLOADED,
    });

    const res = await request(app)
      .post('/api/v1/sessions')
      .set('Authorization', bearer(accessToken))
      .send({ mode: SessionMode.UPLOAD, datasetId: String(dataset._id) });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Dataset is not usable (status: uploaded)');
  });

  it('rejects an upload session on a dataset that failed parsing', async () => {
    const { user, accessToken } = await seedUser();
    const dataset = await createDataset(user._id, {
      status: DatasetStatus.INVALID,
    });

    const res = await request(app)
      .post('/api/v1/sessions')
      .set('Authorization', bearer(accessToken))
      .send({ mode: SessionMode.UPLOAD, datasetId: String(dataset._id) });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Dataset is not usable (status: invalid)');
  });

  /**
   * A simulation replays synthetic signal, so a datasetId sent alongside one is
   * meaningless. It must not be stored, or the history would label the session
   * with a recording it never read.
   */
  it('drops a datasetId supplied for a simulation session', async () => {
    const { user, accessToken } = await seedUser();
    const dataset = await createDataset(user._id);

    const res = await request(app)
      .post('/api/v1/sessions')
      .set('Authorization', bearer(accessToken))
      .send({ mode: SessionMode.SIMULATION, datasetId: String(dataset._id) });

    expect(res.status).toBe(201);
    expect(res.body.data.datasetId).toBeUndefined();

    const stored = await Session.findById(res.body.data._id);
    expect(stored!.datasetId).toBeUndefined();
  });

  it('rejects a mode outside the enum', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .post('/api/v1/sessions')
      .set('Authorization', bearer(accessToken))
      .send({ mode: 'telepathy' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid enum value/);
    expect(await Session.countDocuments()).toBe(0);
  });

  it('rejects a request with no mode', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .post('/api/v1/sessions')
      .set('Authorization', bearer(accessToken))
      .send({});

    expect(res.status).toBe(400);
    expect(await Session.countDocuments()).toBe(0);
  });

  it('rejects a datasetId that is not an ObjectId', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .post('/api/v1/sessions')
      .set('Authorization', bearer(accessToken))
      .send({ mode: SessionMode.UPLOAD, datasetId: 'not-an-object-id' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid dataset ID format');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app)
      .post('/api/v1/sessions')
      .send({ mode: SessionMode.SIMULATION });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Access token required');
    expect(await Session.countDocuments()).toBe(0);
  });
});

describe('GET /api/v1/sessions', () => {
  it('returns only the caller’s sessions', async () => {
    const { owner, intruder } = await seedOwnerAndIntruder();
    const mine = await createSession(owner.user._id);
    await createSession(intruder.user._id);

    const res = await request(app)
      .get('/api/v1/sessions')
      .set('Authorization', bearer(owner.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Sessions retrieved successfully');
    expect(res.body.data.sessions).toHaveLength(1);
    expect(res.body.data.sessions[0]._id).toBe(String(mine._id));
    expect(res.body.data.pagination.total).toBe(1);
  });

  it('orders the history newest first', async () => {
    const { user, accessToken } = await seedUser();
    const older = await createSession(user._id, {
      createdAt: new Date('2026-01-01T10:00:00Z'),
    });
    const newer = await createSession(user._id, {
      createdAt: new Date('2026-01-02T10:00:00Z'),
    });

    const res = await request(app)
      .get('/api/v1/sessions')
      .set('Authorization', bearer(accessToken));

    expect(res.body.data.sessions.map((s: { _id: string }) => s._id)).toEqual([
      String(newer._id),
      String(older._id),
    ]);
  });

  it('reports pagination and returns the requested page', async () => {
    const { user, accessToken } = await seedUser();
    for (let i = 0; i < 5; i++) {
      await createSession(user._id, {
        createdAt: new Date(`2026-01-0${i + 1}T10:00:00Z`),
      });
    }

    const res = await request(app)
      .get('/api/v1/sessions?page=2&limit=2')
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.data.sessions).toHaveLength(2);
    expect(res.body.data.pagination).toEqual({
      page: 2,
      limit: 2,
      total: 5,
      pages: 3,
    });
  });

  /** The last page is partial; a client paging to the end must not over-read. */
  it('returns the remainder on the final page', async () => {
    const { user, accessToken } = await seedUser();
    for (let i = 0; i < 5; i++) {
      await createSession(user._id);
    }

    const res = await request(app)
      .get('/api/v1/sessions?page=3&limit=2')
      .set('Authorization', bearer(accessToken));

    expect(res.body.data.sessions).toHaveLength(1);
    expect(res.body.data.pagination.pages).toBe(3);
  });

  it('returns an empty page past the end of the history', async () => {
    const { user, accessToken } = await seedUser();
    await createSession(user._id);

    const res = await request(app)
      .get('/api/v1/sessions?page=9&limit=10')
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.data.sessions).toEqual([]);
    expect(res.body.data.pagination.total).toBe(1);
  });

  it('filters by mode', async () => {
    const { user, accessToken } = await seedUser();
    const hardware = await createSession(user._id, {
      mode: SessionMode.HARDWARE,
    });
    await createSession(user._id, { mode: SessionMode.SIMULATION });

    const res = await request(app)
      .get('/api/v1/sessions?mode=hardware')
      .set('Authorization', bearer(accessToken));

    expect(res.body.data.sessions).toHaveLength(1);
    expect(res.body.data.sessions[0]._id).toBe(String(hardware._id));
    expect(res.body.data.pagination.total).toBe(1);
  });

  it('filters by status', async () => {
    const { user, accessToken } = await seedUser();
    const completed = await createSession(user._id, {
      status: SessionStatus.COMPLETED,
    });
    await createSession(user._id, { status: SessionStatus.PENDING });

    const res = await request(app)
      .get('/api/v1/sessions?status=completed')
      .set('Authorization', bearer(accessToken));

    expect(res.body.data.sessions).toHaveLength(1);
    expect(res.body.data.sessions[0]._id).toBe(String(completed._id));
  });

  /**
   * A mode filter must never widen the userId filter it is merged into — a
   * regression here would leak the whole system's history one mode at a time.
   */
  it('keeps the ownership filter when a mode filter is applied', async () => {
    const { owner, intruder } = await seedOwnerAndIntruder();
    await createSession(intruder.user._id, { mode: SessionMode.HARDWARE });

    const res = await request(app)
      .get('/api/v1/sessions?mode=hardware')
      .set('Authorization', bearer(owner.accessToken));

    expect(res.body.data.sessions).toEqual([]);
    expect(res.body.data.pagination.total).toBe(0);
  });

  it('names the dataset on an upload session so the history can title it', async () => {
    const { user, accessToken } = await seedUser();
    const dataset = await createDataset(user._id, { originalName: 'A03T.gdf' });
    await createSession(user._id, {
      mode: SessionMode.UPLOAD,
      datasetId: dataset._id,
    });

    const res = await request(app)
      .get('/api/v1/sessions')
      .set('Authorization', bearer(accessToken));

    expect(res.body.data.sessions[0].datasetId).toMatchObject({
      originalName: 'A03T.gdf',
      format: 'gdf',
    });
    expect(res.body.data.sessions[0].sourceLabel).toBe('A03T.gdf');
  });

  it('rejects a limit above the 200 cap', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .get('/api/v1/sessions?limit=500')
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(400);
  });

  it('rejects a non-positive page', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .get('/api/v1/sessions?page=0')
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(400);
  });

  it('rejects a mode filter outside the enum', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .get('/api/v1/sessions?mode=telepathy')
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid enum value/);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/sessions');

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Access token required');
  });
});

describe('GET /api/v1/sessions/:sessionId', () => {
  it('returns the session with its per-class breakdown', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id, {
      status: SessionStatus.COMPLETED,
      epochCount: 3,
    });
    await Classification.create([
      {
        sessionId: session._id,
        epochIndex: 0,
        epochTimestamp: 0,
        predictedClass: MILabel.LEFT_HAND,
        confidence: 0.9,
      },
      {
        sessionId: session._id,
        epochIndex: 1,
        epochTimestamp: 1,
        predictedClass: MILabel.LEFT_HAND,
        confidence: 0.7,
      },
      {
        sessionId: session._id,
        epochIndex: 2,
        epochTimestamp: 2,
        predictedClass: MILabel.FEET,
        confidence: 0.5,
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/sessions/${session._id}`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Session retrieved successfully');
    expect(res.body.data.session._id).toBe(String(session._id));
    // Sorted by count descending, so the dominant class leads.
    expect(res.body.data.breakdown).toEqual([
      { _id: 'left_hand', count: 2, meanConfidence: 0.8 },
      { _id: 'feet', count: 1, meanConfidence: 0.5 },
    ]);
  });

  it('counts only the epochs of the session asked for', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id);
    const other = await createSession(user._id);
    await Classification.create({
      sessionId: other._id,
      epochIndex: 0,
      epochTimestamp: 0,
      predictedClass: MILabel.RIGHT_HAND,
      confidence: 0.9,
    });

    const res = await request(app)
      .get(`/api/v1/sessions/${session._id}`)
      .set('Authorization', bearer(accessToken));

    expect(res.body.data.breakdown).toEqual([]);
  });

  /**
   * hasGroundTruth tells the client whether to render a dash or wait for a
   * number, so it has to survive serialisation of the response.
   */
  it('marks a hardware session as having no ground truth', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id, {
      mode: SessionMode.HARDWARE,
    });

    const res = await request(app)
      .get(`/api/v1/sessions/${session._id}`)
      .set('Authorization', bearer(accessToken));

    expect(res.body.data.session.hasGroundTruth).toBe(false);
    expect(res.body.data.session.sourceLabel).toBe('Hardware Stream');
  });

  it('refuses to read another user’s session', async () => {
    const { owner, intruder } = await seedOwnerAndIntruder();
    const session = await createSession(owner.user._id);

    const res = await request(app)
      .get(`/api/v1/sessions/${session._id}`)
      .set('Authorization', bearer(intruder.accessToken));

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This session belongs to another user');
  });

  it('returns 404 for a session that does not exist', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .get(`/api/v1/sessions/${missingId()}`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Session not found');
  });

  /**
   * Without the regex guard a malformed id reaches Mongoose and surfaces as a
   * CastError, which is a different status and a leakier message.
   */
  it('rejects a malformed session id', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .get('/api/v1/sessions/not-an-object-id')
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid session ID format');
  });

  it('rejects an unauthenticated request', async () => {
    const { user } = await seedUser();
    const session = await createSession(user._id);

    const res = await request(app).get(`/api/v1/sessions/${session._id}`);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Access token required');
  });
});

describe('GET /api/v1/sessions/:sessionId/classifications', () => {
  const seedEpochs = async (sessionId: unknown) =>
    Classification.create([
      {
        sessionId,
        epochIndex: 2,
        epochTimestamp: 8,
        predictedClass: MILabel.FEET,
        confidence: 0.5,
        features: [1, 2, 3],
      },
      {
        sessionId,
        epochIndex: 0,
        epochTimestamp: 0,
        predictedClass: MILabel.LEFT_HAND,
        confidence: 0.9,
        features: [4, 5, 6],
      },
      {
        sessionId,
        epochIndex: 1,
        epochTimestamp: 4,
        predictedClass: MILabel.RIGHT_HAND,
        confidence: 0.7,
        features: [7, 8, 9],
      },
    ]);

  it('returns the epoch log in epoch order', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id);
    await seedEpochs(session._id);

    const res = await request(app)
      .get(`/api/v1/sessions/${session._id}/classifications`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Classifications retrieved successfully');
    expect(
      res.body.data.map((c: { epochIndex: number }) => c.epochIndex)
    ).toEqual([0, 1, 2]);
  });

  /**
   * The feature vector is large and of no use to the client; it exists for
   * offline analysis. Shipping it would bloat every history request.
   */
  it('omits the feature vectors', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id);
    await seedEpochs(session._id);

    const res = await request(app)
      .get(`/api/v1/sessions/${session._id}/classifications`)
      .set('Authorization', bearer(accessToken));

    res.body.data.forEach((row: Record<string, unknown>) => {
      expect(row).not.toHaveProperty('features');
    });
  });

  it('returns an empty log for a session that never streamed', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id);

    const res = await request(app)
      .get(`/api/v1/sessions/${session._id}/classifications`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('refuses to read another user’s epoch log', async () => {
    const { owner, intruder } = await seedOwnerAndIntruder();
    const session = await createSession(owner.user._id);
    await seedEpochs(session._id);

    const res = await request(app)
      .get(`/api/v1/sessions/${session._id}/classifications`)
      .set('Authorization', bearer(intruder.accessToken));

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This session belongs to another user');
    expect(res.body.data).toBeUndefined();
  });

  it('returns 404 for a session that does not exist', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .get(`/api/v1/sessions/${missingId()}/classifications`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Session not found');
  });

  it('rejects a malformed session id', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .get('/api/v1/sessions/not-an-object-id/classifications')
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid session ID format');
  });

  it('rejects an unauthenticated request', async () => {
    const { user } = await seedUser();
    const session = await createSession(user._id);

    const res = await request(app).get(
      `/api/v1/sessions/${session._id}/classifications`
    );

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Access token required');
  });
});

describe('DELETE /api/v1/sessions/:sessionId', () => {
  const seedSessionWithEpochs = async (user: IUser) => {
    const session = await createSession(user._id);
    await Classification.create({
      sessionId: session._id,
      epochIndex: 0,
      epochTimestamp: 0,
      predictedClass: MILabel.LEFT_HAND,
      confidence: 0.9,
    });
    return session;
  };

  it('removes the session', async () => {
    const { user, accessToken } = await seedUser();
    const session = await seedSessionWithEpochs(user);

    const res = await request(app)
      .delete(`/api/v1/sessions/${session._id}`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      message: 'Session deleted successfully',
    });
    expect(await Session.findById(session._id)).toBeNull();
  });

  /**
   * Epochs are only reachable through their session, so leaving them behind
   * would orphan rows that nothing can ever read or clean up.
   */
  it('removes the epochs recorded under it', async () => {
    const { user, accessToken } = await seedUser();
    const session = await seedSessionWithEpochs(user);

    await request(app)
      .delete(`/api/v1/sessions/${session._id}`)
      .set('Authorization', bearer(accessToken));

    expect(
      await Classification.countDocuments({ sessionId: session._id })
    ).toBe(0);
  });

  it('leaves other sessions’ epochs alone', async () => {
    const { user, accessToken } = await seedUser();
    const session = await seedSessionWithEpochs(user);
    const survivor = await seedSessionWithEpochs(user);

    await request(app)
      .delete(`/api/v1/sessions/${session._id}`)
      .set('Authorization', bearer(accessToken));

    expect(
      await Classification.countDocuments({ sessionId: survivor._id })
    ).toBe(1);
  });

  it('refuses to delete another user’s session and leaves it intact', async () => {
    const { owner, intruder } = await seedOwnerAndIntruder();
    const session = await seedSessionWithEpochs(owner.user);

    const res = await request(app)
      .delete(`/api/v1/sessions/${session._id}`)
      .set('Authorization', bearer(intruder.accessToken));

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This session belongs to another user');
    expect(await Session.findById(session._id)).not.toBeNull();
    expect(
      await Classification.countDocuments({ sessionId: session._id })
    ).toBe(1);
  });

  it('returns 404 for a session that does not exist', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .delete(`/api/v1/sessions/${missingId()}`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Session not found');
  });

  it('rejects a malformed session id', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .delete('/api/v1/sessions/not-an-object-id')
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid session ID format');
  });

  it('rejects an unauthenticated request and leaves the session intact', async () => {
    const { user } = await seedUser();
    const session = await createSession(user._id);

    const res = await request(app).delete(`/api/v1/sessions/${session._id}`);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Access token required');
    expect(await Session.findById(session._id)).not.toBeNull();
  });
});
