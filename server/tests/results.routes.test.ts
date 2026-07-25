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

const CSV_HEADER =
  'epoch_index,timestamp,predicted_class,confidence,left_hand,right_hand,feet,true_class,inference_ms';

/**
 * Both routes here authorise by comparing session.userId to the caller, so a
 * second identity is needed to prove that comparison actually rejects.
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
    status: SessionStatus.COMPLETED,
    ...overrides,
  });

interface EpochOverrides {
  epochIndex?: number;
  epochTimestamp?: number;
  predictedClass?: MILabel;
  confidence?: number;
  allScores?: Record<string, number>;
  inferenceMs?: number;
  trueClass?: MILabel;
}

const createEpoch = (sessionId: unknown, overrides: EpochOverrides = {}) =>
  Classification.create({
    sessionId,
    epochIndex: 0,
    epochTimestamp: 0,
    predictedClass: MILabel.LEFT_HAND,
    confidence: 0.9,
    allScores: { left_hand: 0.9, right_hand: 0.05, feet: 0.05 },
    features: [0.1, 0.2, 0.3],
    inferenceMs: 12,
    ...overrides,
  });

const missingId = () => new Types.ObjectId().toString();

/** CSV body rows, header and trailing blank line dropped. */
const rowsOf = (text: string): string[] =>
  text.trim().split('\n').slice(1);

beforeAll(startTestDb);
afterEach(clearTestDb);
afterAll(stopTestDb);

describe('GET /api/v1/results/:sessionId/export', () => {
  it('serves the epoch log as a CSV attachment', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id);
    await createEpoch(session._id);

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/export`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename=/);
  });

  /**
   * The filename is what lands in the researcher's downloads folder, and it is
   * the only thing tying an exported file back to its session. Pin both halves:
   * the session id and the ISO date of the recording.
   */
  it('names the file after the session and the day it started', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id, {
      startTime: new Date('2026-03-14T15:09:26.535Z'),
    });

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/export`)
      .set('Authorization', bearer(accessToken));

    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="session-${session._id}-2026-03-14.csv"`
    );
  });

  it('writes the column header row', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id);
    await createEpoch(session._id);

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/export`)
      .set('Authorization', bearer(accessToken));

    expect(res.text.split('\n')[0]).toBe(CSV_HEADER);
  });

  /** An empty session must still export a well-formed, header-only file. */
  it('writes the header even when nothing was classified', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id, {
      status: SessionStatus.PENDING,
    });

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/export`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(res.text).toBe(`${CSV_HEADER}\n`);
  });

  it('writes one row per epoch, in epoch order', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id);
    await createEpoch(session._id, { epochIndex: 2, epochTimestamp: 8 });
    await createEpoch(session._id, { epochIndex: 0, epochTimestamp: 0 });
    await createEpoch(session._id, { epochIndex: 1, epochTimestamp: 4 });

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/export`)
      .set('Authorization', bearer(accessToken));

    const rows = rowsOf(res.text);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.split(',')[0])).toEqual(['0', '1', '2']);
  });

  it('writes the per-class scores and the cue label of an epoch', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id);
    await createEpoch(session._id, {
      epochIndex: 7,
      epochTimestamp: 28,
      predictedClass: MILabel.RIGHT_HAND,
      confidence: 0.8125,
      allScores: { left_hand: 0.125, right_hand: 0.8125, feet: 0.0625 },
      trueClass: MILabel.RIGHT_HAND,
      inferenceMs: 9,
    });

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/export`)
      .set('Authorization', bearer(accessToken));

    expect(rowsOf(res.text)[0]).toBe(
      '7,28,right_hand,0.8125,0.1250,0.8125,0.0625,right_hand,9'
    );
  });

  /**
   * A hardware recording has no cues, so true_class is empty rather than
   * absent — the column must still be there or the row would be short and the
   * file would not parse.
   */
  it('leaves true_class empty for an epoch with no cue', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id, {
      mode: SessionMode.HARDWARE,
    });
    await createEpoch(session._id, { trueClass: undefined });

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/export`)
      .set('Authorization', bearer(accessToken));

    const cells = rowsOf(res.text)[0].split(',');
    expect(cells).toHaveLength(9);
    expect(cells[7]).toBe('');
  });

  it('exports only the epochs of the session asked for', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id);
    const other = await createSession(user._id);
    await createEpoch(session._id, { epochIndex: 0 });
    await createEpoch(other._id, { epochIndex: 1 });

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/export`)
      .set('Authorization', bearer(accessToken));

    expect(rowsOf(res.text)).toHaveLength(1);
  });

  /**
   * Export is the one route that hands over the raw data in bulk, so a
   * regression in its ownership check would be the worst leak in the API.
   */
  it('refuses to export another user’s session', async () => {
    const { owner, intruder } = await seedOwnerAndIntruder();
    const session = await createSession(owner.user._id);
    await createEpoch(session._id);

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/export`)
      .set('Authorization', bearer(intruder.accessToken));

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This session belongs to another user');
    // Nothing of the file may have been flushed before the check ran.
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.text).not.toContain('epoch_index');
  });

  it('returns 404 for a session that does not exist', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .get(`/api/v1/results/${missingId()}/export`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Session not found');
  });

  it('rejects a malformed session id', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .get('/api/v1/results/not-an-object-id/export')
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid session ID format');
  });

  it('rejects an unauthenticated request', async () => {
    const { user } = await seedUser();
    const session = await createSession(user._id);

    const res = await request(app).get(
      `/api/v1/results/${session._id}/export`
    );

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Access token required');
  });
});

describe('GET /api/v1/results/:sessionId/summary', () => {
  it('returns the session’s identity and timing alongside its statistics', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id, {
      startTime: new Date('2026-03-14T15:00:00.000Z'),
      endTime: new Date('2026-03-14T15:02:00.000Z'),
      durationSeconds: 120,
    });

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/summary`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Summary retrieved successfully');
    expect(res.body.data).toMatchObject({
      sessionId: String(session._id),
      mode: 'simulation',
      status: 'completed',
      startTime: '2026-03-14T15:00:00.000Z',
      endTime: '2026-03-14T15:02:00.000Z',
      durationSeconds: 120,
    });
  });

  it('averages confidence and inference time across the epochs', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id);
    await createEpoch(session._id, {
      epochIndex: 0,
      confidence: 0.6,
      inferenceMs: 10,
    });
    await createEpoch(session._id, {
      epochIndex: 1,
      confidence: 0.8,
      inferenceMs: 20,
    });

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/summary`)
      .set('Authorization', bearer(accessToken));

    expect(res.body.data.epochs).toBe(2);
    expect(res.body.data.meanConfidence).toBeCloseTo(0.7, 10);
    expect(res.body.data.meanInferenceMs).toBe(15);
  });

  it('scores accuracy against the cue labels', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id);
    await createEpoch(session._id, {
      epochIndex: 0,
      predictedClass: MILabel.LEFT_HAND,
      trueClass: MILabel.LEFT_HAND,
    });
    await createEpoch(session._id, {
      epochIndex: 1,
      predictedClass: MILabel.RIGHT_HAND,
      trueClass: MILabel.RIGHT_HAND,
    });
    await createEpoch(session._id, {
      epochIndex: 2,
      predictedClass: MILabel.FEET,
      trueClass: MILabel.LEFT_HAND,
    });
    await createEpoch(session._id, {
      epochIndex: 3,
      predictedClass: MILabel.FEET,
      trueClass: MILabel.RIGHT_HAND,
    });

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/summary`)
      .set('Authorization', bearer(accessToken));

    expect(res.body.data.accuracy).toBeCloseTo(0.5, 10);
    expect(res.body.data.labelledEpochs).toBe(4);
  });

  /**
   * The denominator is the labelled epochs, not every epoch. Counting uncued
   * epochs would drag a partially-cued recording's accuracy down to 1/4 here
   * rather than the true 1/2.
   *
   * This is why the controller tests `$type` rather than `{$ne: [..., null]}`:
   * in the query language `{trueClass: null}` matches a missing field, but in
   * an aggregation expression a missing path is the `missing` value, which is
   * not equal to null — so `$ne` is true for an uncued epoch.
   */
  it('scores accuracy over the labelled epochs only', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id);
    await createEpoch(session._id, {
      epochIndex: 0,
      predictedClass: MILabel.LEFT_HAND,
      trueClass: MILabel.LEFT_HAND,
    });
    await createEpoch(session._id, {
      epochIndex: 1,
      predictedClass: MILabel.FEET,
      trueClass: MILabel.RIGHT_HAND,
    });
    await createEpoch(session._id, { epochIndex: 2, trueClass: undefined });
    await createEpoch(session._id, { epochIndex: 3, trueClass: undefined });

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/summary`)
      .set('Authorization', bearer(accessToken));

    expect(res.body.data.epochs).toBe(4);
    expect(res.body.data.labelledEpochs).toBe(2);
    expect(res.body.data.accuracy).toBeCloseTo(0.5, 10);
  });

  it('counts the epochs of a hardware session', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id, {
      mode: SessionMode.HARDWARE,
    });
    await createEpoch(session._id, { epochIndex: 0, trueClass: undefined });
    await createEpoch(session._id, { epochIndex: 1, trueClass: undefined });

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/summary`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('hardware');
    expect(res.body.data.epochs).toBe(2);
  });

  /**
   * A live headset emits no cue events, so there is nothing to score against
   * and accuracy must come back null rather than 0. The client renders null as
   * a dash and a number as a percentage, so a 0 here would tell the user the
   * model got every epoch wrong when in truth nothing was measurable.
   */
  it('reports no accuracy for a hardware session', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id, {
      mode: SessionMode.HARDWARE,
    });
    await createEpoch(session._id, { epochIndex: 0, trueClass: undefined });
    await createEpoch(session._id, { epochIndex: 1, trueClass: undefined });

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/summary`)
      .set('Authorization', bearer(accessToken));

    expect(res.body.data.labelledEpochs).toBe(0);
    expect(res.body.data.accuracy).toBeNull();
  });

  it('breaks the epochs down by predicted class, commonest first', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id);
    await createEpoch(session._id, {
      epochIndex: 0,
      predictedClass: MILabel.FEET,
    });
    await createEpoch(session._id, {
      epochIndex: 1,
      predictedClass: MILabel.LEFT_HAND,
    });
    await createEpoch(session._id, {
      epochIndex: 2,
      predictedClass: MILabel.LEFT_HAND,
    });

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/summary`)
      .set('Authorization', bearer(accessToken));

    expect(res.body.data.breakdown).toEqual([
      { _id: 'left_hand', count: 2 },
      { _id: 'feet', count: 1 },
    ]);
  });

  /**
   * A session that was created but never streamed is the state the history
   * shows immediately after POST /sessions, so the summary has to survive
   * having no epochs at all rather than dividing by zero.
   */
  it('reports empty statistics for a session that never streamed', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id, {
      status: SessionStatus.PENDING,
    });

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/summary`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      epochs: 0,
      meanConfidence: null,
      meanInferenceMs: null,
      accuracy: null,
      labelledEpochs: 0,
      breakdown: [],
    });
  });

  it('summarises only the epochs of the session asked for', async () => {
    const { user, accessToken } = await seedUser();
    const session = await createSession(user._id);
    const other = await createSession(user._id);
    await createEpoch(session._id, { epochIndex: 0 });
    await createEpoch(other._id, { epochIndex: 0 });
    await createEpoch(other._id, { epochIndex: 1 });

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/summary`)
      .set('Authorization', bearer(accessToken));

    expect(res.body.data.epochs).toBe(1);
  });

  it('refuses to summarise another user’s session', async () => {
    const { owner, intruder } = await seedOwnerAndIntruder();
    const session = await createSession(owner.user._id);
    await createEpoch(session._id);

    const res = await request(app)
      .get(`/api/v1/results/${session._id}/summary`)
      .set('Authorization', bearer(intruder.accessToken));

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This session belongs to another user');
    expect(res.body.data).toBeUndefined();
  });

  it('returns 404 for a session that does not exist', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .get(`/api/v1/results/${missingId()}/summary`)
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Session not found');
  });

  it('rejects a malformed session id', async () => {
    const { accessToken } = await seedUser();

    const res = await request(app)
      .get('/api/v1/results/not-an-object-id/summary')
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid session ID format');
  });

  it('rejects an unauthenticated request', async () => {
    const { user } = await seedUser();
    const session = await createSession(user._id);

    const res = await request(app).get(
      `/api/v1/results/${session._id}/summary`
    );

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Access token required');
  });
});
