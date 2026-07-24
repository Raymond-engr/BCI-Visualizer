import request from 'supertest';
import {
  app,
  bearer,
  clearTestDb,
  seedUser,
  startTestDb,
  stopTestDb,
} from './helpers/api';
import Preference from '../src/Preferences/models/preference.model';
import { BANDPASS_TABLE } from '../src/Signal_Processing/services/filters.service';

/**
 * The exact wording the settings page shows when a band has no coefficients.
 * Built from the same table the controller reads so that adding a band to
 * filters.service updates this expectation with it — but written out in full
 * here, because the point of the case is that the user is told which bands they
 * may actually pick, not merely that something was rejected.
 */
const SUPPORTED_BANDS = '8–30 Hz, 4–40 Hz, 8–12 Hz, 13–30 Hz, 1–45 Hz';

const put = (token: string, body: Record<string, unknown>): request.Test =>
  request(app)
    .put('/api/v1/preferences')
    .set('Authorization', bearer(token))
    .send(body);

const get = (token: string): request.Test =>
  request(app).get('/api/v1/preferences').set('Authorization', bearer(token));

const seedSecondUser = () =>
  seedUser({ name: 'Other Researcher', email: 'other@example.com' });

beforeAll(startTestDb);
afterEach(clearTestDb);
afterAll(stopTestDb);

describe('GET /api/v1/preferences', () => {
  /**
   * The settings page reads preferences before it has ever written any, so the
   * first read has to materialise a row rather than return null.
   */
  it('creates defaults on the first read', async () => {
    const { user, accessToken } = await seedUser();
    expect(await Preference.countDocuments({ userId: user._id })).toBe(0);

    const res = await get(accessToken);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      message: 'Preferences retrieved successfully',
    });
    expect(res.body.data).toMatchObject({
      userId: String(user._id),
      bandpassLow: 8,
      bandpassHigh: 30,
      notchEnabled: true,
      defaultMode: 'simulation',
      defaultModelId: 'global',
    });
  });

  it('persists the defaults it created', async () => {
    const { user, accessToken } = await seedUser();

    await get(accessToken);

    const stored = await Preference.findOne({ userId: user._id });
    expect(stored).not.toBeNull();
    expect(stored!.bandpassLow).toBe(8);
    expect(stored!.bandpassHigh).toBe(30);
  });

  /** The upsert must match the existing row, not race a second one into being. */
  it('returns the same row on a second read rather than creating another', async () => {
    const { user, accessToken } = await seedUser();

    const first = await get(accessToken);
    const second = await get(accessToken);

    expect(second.body.data._id).toBe(first.body.data._id);
    expect(await Preference.countDocuments({ userId: user._id })).toBe(1);
  });

  it('defaults the band to one the coefficient table actually covers', async () => {
    const { accessToken } = await seedUser();

    const res = await get(accessToken);

    const options = await request(app)
      .get('/api/v1/preferences/options')
      .set('Authorization', bearer(accessToken));

    expect(options.body.data.bandpassOptions).toContainEqual({
      low: res.body.data.bandpassLow,
      high: res.body.data.bandpassHigh,
      label: expect.any(String),
    });
  });

  it('returns the settings already saved instead of the defaults', async () => {
    const { user, accessToken } = await seedUser();
    await Preference.create({
      userId: user._id,
      bandpassLow: 13,
      bandpassHigh: 30,
      notchEnabled: false,
      defaultMode: 'upload',
      defaultModelId: 'csp_lda_s1',
    });

    const res = await get(accessToken);

    expect(res.body.data).toMatchObject({
      bandpassLow: 13,
      bandpassHigh: 30,
      notchEnabled: false,
      defaultMode: 'upload',
      defaultModelId: 'csp_lda_s1',
    });
  });

  it("never returns another user's settings", async () => {
    const { accessToken } = await seedUser();
    const { user: other } = await seedSecondUser();
    await Preference.create({ userId: other._id, defaultModelId: 'theirs' });

    const res = await get(accessToken);

    expect(res.body.data.defaultModelId).toBe('global');
    expect(res.body.data.userId).not.toBe(String(other._id));
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/preferences');

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Access token required');
  });

  it('creates nothing for an unauthenticated request', async () => {
    await request(app).get('/api/v1/preferences');

    expect(await Preference.countDocuments()).toBe(0);
  });
});

describe('GET /api/v1/preferences/options', () => {
  const options = (token: string) =>
    request(app)
      .get('/api/v1/preferences/options')
      .set('Authorization', bearer(token));

  /**
   * These are fixed pipeline constants, not preferences. The settings page
   * quotes them, so they are served rather than hard-coded in the frontend.
   */
  it('reports the pipeline constants the settings page displays', async () => {
    const { accessToken } = await seedUser();

    const res = await options(accessToken);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Options retrieved successfully');
    expect(res.body.data).toMatchObject({
      sampleRate: 250,
      epochSeconds: 4,
      notchFreq: 50,
    });
  });

  /**
   * Coefficients are precomputed offline, so the page offers a select built from
   * this list rather than a free-text field that would mostly produce 400s.
   */
  it('offers exactly the bands that have precomputed coefficients', async () => {
    const { accessToken } = await seedUser();

    const res = await options(accessToken);

    expect(res.body.data.bandpassOptions).toEqual([
      { low: 8, high: 30, label: '8–30 Hz' },
      { low: 4, high: 40, label: '4–40 Hz' },
      { low: 8, high: 12, label: '8–12 Hz' },
      { low: 13, high: 30, label: '13–30 Hz' },
      { low: 1, high: 45, label: '1–45 Hz' },
    ]);
  });

  /** Every offered band must survive a PUT, or the select would be a trap. */
  it('offers only bands that PUT accepts', async () => {
    const { accessToken } = await seedUser();
    const res = await options(accessToken);

    for (const band of res.body.data.bandpassOptions) {
      const saved = await put(accessToken, {
        bandpassLow: band.low,
        bandpassHigh: band.high,
      });

      expect(saved.status).toBe(200);
    }
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/preferences/options');

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Access token required');
  });
});

describe('PUT /api/v1/preferences', () => {
  /**
   * The band a session filters with is chosen from a table of sections computed
   * offline with SciPy, so that the server filters a sample exactly the way the
   * training pipeline did. An arbitrary band cannot be designed at runtime, and
   * accepting one here would surface as a 500 on the first epoch instead.
   */
  it('rejects a band that has no precomputed filter, naming the ones that do', async () => {
    const { accessToken } = await seedUser();

    const res = await put(accessToken, { bandpassLow: 9, bandpassHigh: 31 });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(
      `No filter is available for 9-31 Hz. Supported bands: ${SUPPORTED_BANDS}.`
    );
  });

  it('leaves the saved band untouched when it rejects one', async () => {
    const { user, accessToken } = await seedUser();
    await put(accessToken, { bandpassLow: 13, bandpassHigh: 30 });

    await put(accessToken, { bandpassLow: 9, bandpassHigh: 31 });

    const stored = await Preference.findOne({ userId: user._id });
    expect(stored!.bandpassLow).toBe(13);
    expect(stored!.bandpassHigh).toBe(30);
  });

  /**
   * A band inside the schema's 0.5-125 Hz range is still rejected when no
   * section exists for it: the range is a sanity bound, the table is the
   * contract.
   */
  it('rejects a plausible band that simply is not in the table', async () => {
    const { accessToken } = await seedUser();

    const res = await put(accessToken, { bandpassLow: 10, bandpassHigh: 20 });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('No filter is available for 10-20 Hz');
  });

  /**
   * PUT is a partial update — every field is optional, and the settings page is
   * free to send one cutoff on its own. What gets filtered is the band the saved
   * row forms, not the band a single request happened to mention, so a lone
   * cutoff still has to be reconciled against its stored other half.
   *
   * FAILING: documents a real defect, see the report. preference.controller.ts:51
   * only consults the table when both cutoffs are present, so this request is
   * saved as 9-30 — a band with no precomputed section.
   */
  it('rejects a lone cutoff that forms an unsupported band with the stored one', async () => {
    const { user, accessToken } = await seedUser();
    await put(accessToken, { bandpassLow: 8, bandpassHigh: 30 });

    const res = await put(accessToken, { bandpassLow: 9 });

    expect(res.status).toBe(400);
    // Whatever ends up stored must be a band the pipeline can actually filter.
    const stored = await Preference.findOne({ userId: user._id });
    expect(
      BANDPASS_TABLE[`${stored!.bandpassLow}-${stored!.bandpassHigh}@250`]
    ).toBeDefined();
  });

  /**
   * FAILING: the same defect on the ordering guard at
   * preference.controller.ts:38 — a lone upper cutoff below the stored lower one
   * is saved as the inverted band 8-4.
   */
  it('rejects a lone upper cutoff that falls below the stored lower one', async () => {
    const { user, accessToken } = await seedUser();
    await put(accessToken, { bandpassLow: 8, bandpassHigh: 30 });

    const res = await put(accessToken, { bandpassHigh: 4 });

    expect(res.status).toBe(400);
    const stored = await Preference.findOne({ userId: user._id });
    expect(stored!.bandpassLow).toBeLessThan(stored!.bandpassHigh);
  });

  it('saves a supported band', async () => {
    const { user, accessToken } = await seedUser();

    const res = await put(accessToken, { bandpassLow: 4, bandpassHigh: 40 });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Preferences updated successfully');
    expect(res.body.data).toMatchObject({ bandpassLow: 4, bandpassHigh: 40 });

    const stored = await Preference.findOne({ userId: user._id });
    expect(stored!.bandpassLow).toBe(4);
    expect(stored!.bandpassHigh).toBe(40);
  });

  it('rejects a lower cutoff at or above the upper one', async () => {
    const { accessToken } = await seedUser();

    const res = await put(accessToken, { bandpassLow: 30, bandpassHigh: 8 });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(
      'Bandpass lower cutoff must be below the upper cutoff'
    );
  });

  it('rejects a band whose cutoffs are equal', async () => {
    const { accessToken } = await seedUser();

    const res = await put(accessToken, { bandpassLow: 30, bandpassHigh: 30 });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(
      'Bandpass lower cutoff must be below the upper cutoff'
    );
  });

  it('rejects a cutoff below the acquisition range', async () => {
    const { accessToken } = await seedUser();

    const res = await put(accessToken, { bandpassLow: 0.2, bandpassHigh: 30 });

    expect(res.status).toBe(400);
  });

  it('rejects a cutoff above the Nyquist bound', async () => {
    const { accessToken } = await seedUser();

    const res = await put(accessToken, { bandpassLow: 8, bandpassHigh: 200 });

    expect(res.status).toBe(400);
  });

  it('saves the notch toggle', async () => {
    const { user, accessToken } = await seedUser();

    const res = await put(accessToken, { notchEnabled: false });

    expect(res.status).toBe(200);
    expect(res.body.data.notchEnabled).toBe(false);
    expect((await Preference.findOne({ userId: user._id }))!.notchEnabled).toBe(
      false
    );
  });

  it('saves the default session mode and model', async () => {
    const { accessToken } = await seedUser();

    const res = await put(accessToken, {
      defaultMode: 'hardware',
      defaultModelId: 'csp_lda_s3',
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      defaultMode: 'hardware',
      defaultModelId: 'csp_lda_s3',
    });
  });

  it('rejects a session mode the server has no source for', async () => {
    const { accessToken } = await seedUser();

    const res = await put(accessToken, { defaultMode: 'telepathy' });

    expect(res.status).toBe(400);
  });

  it('rejects an empty model id', async () => {
    const { accessToken } = await seedUser();

    const res = await put(accessToken, { defaultModelId: '' });

    expect(res.status).toBe(400);
  });

  /**
   * The schema is strict, so a setting the pipeline does not honour is refused
   * rather than stored — a stored value would imply the server acts on it.
   */
  it('rejects a setting the server does not act on', async () => {
    const { accessToken } = await seedUser();

    const res = await put(accessToken, { icaArtifactRejection: true });

    expect(res.status).toBe(400);
  });

  it('leaves settings the request did not mention alone', async () => {
    const { accessToken } = await seedUser();
    await put(accessToken, { bandpassLow: 13, bandpassHigh: 30 });

    const res = await put(accessToken, { defaultModelId: 'csp_lda_s2' });

    expect(res.body.data).toMatchObject({
      bandpassLow: 13,
      bandpassHigh: 30,
      defaultModelId: 'csp_lda_s2',
    });
  });

  /** Settings are written before they are ever read on a fresh account. */
  it('creates the row when the user has never read their preferences', async () => {
    const { user, accessToken } = await seedUser();

    const res = await put(accessToken, { notchEnabled: false });

    expect(res.status).toBe(200);
    expect(await Preference.countDocuments({ userId: user._id })).toBe(1);
    expect(res.body.data.bandpassLow).toBe(8);
  });

  it("does not touch another user's settings", async () => {
    const { accessToken } = await seedUser();
    const { user: other, accessToken: otherToken } = await seedSecondUser();
    await put(otherToken, { bandpassLow: 8, bandpassHigh: 12 });

    await put(accessToken, { bandpassLow: 1, bandpassHigh: 45 });

    const theirs = await Preference.findOne({ userId: other._id });
    expect(theirs!.bandpassLow).toBe(8);
    expect(theirs!.bandpassHigh).toBe(12);
    expect(await Preference.countDocuments()).toBe(2);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app)
      .put('/api/v1/preferences')
      .send({ notchEnabled: false });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Access token required');
    expect(await Preference.countDocuments()).toBe(0);
  });
});
