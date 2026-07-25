import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import WebSocket, { WebSocketServer } from 'ws';
import {
  app,
  bearer,
  clearTestDb,
  seedUser,
  startTestDb,
  stopTestDb,
} from './helpers/api';

/**
 * The streaming layer reads two artefacts off disk that a fresh clone does not
 * ship: the reference recording replayed by simulation mode
 * (REFERENCE_DATASET_PATH, default ./models/A01T.gdf) and the CSP spatial
 * filters applied to every closed epoch (MODEL_DIR/csp_global.json). Both paths
 * are resolved once, at config module load, so they cannot be redirected from a
 * test body — hence a mock factory, which jest hoists above the imports above.
 *
 * The factory writes a synthetic stand-in for each and points the real config at
 * them, then returns the genuine module. Nothing in the pipeline is faked by
 * this: the CSV goes through the real parser, the real montage reconciliation
 * and the real filter/epoch/PSD chain. Only the two files' *contents* are
 * synthetic, because the trained ones are not in the repo.
 */
jest.mock('../src/config/streaming', () => {
  // jest hoists this factory above the import block, so its dependencies have
  // to be pulled in with require() — an ES import here would not have been
  // evaluated yet.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { channelOrder } = require('../src/utils/montage');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bci-streaming-'));

  // Four spatial filters over the 22 montage channels. loadCSPFilters rejects a
  // matrix whose width is not the montage width, so the shape has to be real
  // even though the coefficients are arbitrary.
  fs.writeFileSync(
    path.join(dir, 'csp_global.json'),
    JSON.stringify({
      filters: Array.from({ length: 4 }, (_unused, k) =>
        channelOrder.map((_label: string, c: number) => Math.sin((k + 1) * (c + 1)))
      ),
      channels: channelOrder,
    })
  );

  // Six seconds at 250 Hz: long enough for three epochs (the first at 4 s, then
  // one per second) and short enough that a test can watch a whole session run
  // to COMPLETED. No time column, so the parser falls back to the configured
  // 250 Hz.
  const TOTAL_SAMPLES = 1500;
  const rows = [channelOrder.join(',')];
  for (let s = 0; s < TOTAL_SAMPLES; s++) {
    rows.push(
      channelOrder
        .map((_label: string, c: number) =>
          (20 * Math.sin((2 * Math.PI * 10 * s) / 250 + c)).toFixed(3)
        )
        .join(',')
    );
  }
  fs.writeFileSync(path.join(dir, 'reference.csv'), `${rows.join('\n')}\n`);

  process.env.MODEL_DIR = dir;
  process.env.REFERENCE_DATASET_PATH = path.join(dir, 'reference.csv');
  fixtureHome().__bciFixtureDir = dir;

  return jest.requireActual('../src/config/streaming');
});

/**
 * Where the mock factory parks the fixture directory so afterAll can remove
 * it. A function declaration, because it is hoisted alongside the factory and
 * so exists by the time jest invokes it.
 */
function fixtureHome(): { __bciFixtureDir?: string } {
  return globalThis as typeof globalThis & { __bciFixtureDir?: string };
}

import fs from 'fs';
import SessionManager from '../src/Streaming/services/sessionManager.service';
import { setClassifier } from '../src/Classification/services/mlServiceClient.service';
import Session, {
  SessionMode,
  SessionStatus,
} from '../src/Sessions/models/session.model';
import Classification, {
  MILabel,
} from '../src/Classification/models/classification.model';
import { channelOrder } from '../src/utils/montage';

const SAMPLE_RATE = 250;
const PACKET_SAMPLES = 10;
/** 10 samples per packet at 250 Hz — a packet every 40 ms, i.e. 25 Hz. */
const PACKETS_PER_EPOCH_STEP = 25;
/** The first epoch needs a full 4 s window: 1000 samples / 10 = 100 packets. */
const PACKETS_TO_FIRST_EPOCH = 100;

/**
 * A decoded protocol frame. Kept structural rather than reusing the server's
 * OutboundMessage union: these tests deliberately read fields the union only
 * carries on some variants, and narrowing at every assertion would obscure
 * what is being checked.
 */
type Frame = {
  type: string;
  status?: string;
  message?: string;
  sessionId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [field: string]: any;
};

/**
 * A stand-in inference backend.
 *
 * models/ ships without an .onnx export, so the real ONNXClassifier throws on
 * every classify() call and no epoch could ever be delivered. mlServiceClient
 * exports setClassifier for exactly this ("Replace the backend. Used by
 * tests."), so the seam is the product's own. What this suite asserts about
 * classification is therefore that the streaming layer *routes* it onto the
 * right packet — not that any prediction is correct.
 */
const stubClassifier = {
  classify: async (_features: number[], modelId = 'global') => ({
    predictedClass: MILabel.LEFT_HAND,
    confidence: 0.9125,
    allScores: { left_hand: 0.9125, right_hand: 0.0625, feet: 0.025 },
    inferenceMs: 1.5,
    modelId,
  }),
  load: async () => undefined,
  get loadedModels() {
    return ['global'];
  },
};

let server: http.Server;
let wss: WebSocketServer;
let manager: SessionManager;
let port: number;

const sockets: WebSocket[] = [];
const inboxes = new WeakMap<WebSocket, Frame[]>();

/** Open a client socket against the test server and start recording its frames. */
const openSocket = async (): Promise<WebSocket> => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/stream`);
  const frames: Frame[] = [];
  inboxes.set(socket, frames);
  sockets.push(socket);

  // Registered before the socket opens so no frame can land before the recorder
  // does; waitFor() replays what is already buffered before it starts waiting.
  socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())));

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  return socket;
};

/** Resolve with the first recorded frame matching `predicate`. */
const waitFor = (
  socket: WebSocket,
  predicate: (frame: Frame) => boolean,
  timeoutMs = 15000
): Promise<Frame> =>
  new Promise((resolve, reject) => {
    const frames = inboxes.get(socket)!;
    let cursor = 0;

    const timer = setTimeout(() => {
      socket.off('message', scan);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for a frame`));
    }, timeoutMs);

    function scan() {
      while (cursor < frames.length) {
        const frame = frames[cursor++];
        if (predicate(frame)) {
          clearTimeout(timer);
          socket.off('message', scan);
          resolve(frame);
          return;
        }
      }
    }

    socket.on('message', scan);
    scan();
  });

const waitForStatus = (socket: WebSocket, status: string, timeoutMs?: number) =>
  waitFor(
    socket,
    (frame) => frame.type === 'STATUS' && frame.status === status,
    timeoutMs
  );

/** Resolve with the close code and reason the server sent. */
const waitForClose = (
  socket: WebSocket,
  timeoutMs = 10000
): Promise<{ code: number; reason: string }> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for close')),
      timeoutMs
    );
    socket.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });

/** Collect the next `count` DATA_PACKETs. */
const collectPackets = async (
  socket: WebSocket,
  count: number,
  timeoutMs = 25000
): Promise<Frame[]> => {
  const frames = inboxes.get(socket)!;
  const packets: Frame[] = [];
  await waitFor(
    socket,
    (frame) => frame.type === 'DATA_PACKET' && packets.push(frame) >= count,
    timeoutMs
  );
  void frames;
  return packets;
};

const send = (socket: WebSocket, message: Record<string, unknown>) =>
  socket.send(JSON.stringify(message));

/**
 * Wait for the server's post-reply bookkeeping to land.
 *
 * onConnect writes the session's failure state *after* it has already put the
 * ERROR frame (or the close) on the wire, so a read taken the moment the client
 * hears back races that write and can still see the previous status.
 */
const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create the session over REST, which is the real client flow: POST /sessions
 * reserves the document, and the id it returns is what the INIT frame names.
 */
const createSession = async (
  token: string,
  mode: SessionMode = SessionMode.SIMULATION
): Promise<string> => {
  const response = await request(app)
    .post('/api/v1/sessions')
    .set('Authorization', bearer(token))
    .send({ mode });

  expect(response.status).toBe(201);
  return String(response.body.data._id);
};

beforeAll(async () => {
  await startTestDb();

  // Must precede the SessionManager, whose constructor resolves the backend once.
  setClassifier(stubClassifier);

  // index.ts wires these together at boot but calls startServer() on import, so
  // the same wiring is reproduced here on an ephemeral port instead.
  server = http.createServer(app);
  wss = new WebSocketServer({ server, path: '/ws/stream' });
  manager = new SessionManager(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  sockets.splice(0).forEach((socket) => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  });

  // A dropped client is noticed on the stream's next 40 ms tick, which then
  // finalises the session. Letting that land before the collections are emptied
  // keeps its writes out of the following test.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await clearTestDb();
});

afterAll(async () => {
  manager.shutdown();
  // Closing the server first refuses new sockets; closing the wss afterwards is
  // what clears the heartbeat interval, which would otherwise hold Jest open.
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  setClassifier(null);
  await stopTestDb();
});

describe('INIT authentication', () => {
  it('rejects an INIT with no token, since a browser cannot put one in a header', async () => {
    const { user } = await seedUser();
    const sessionId = String(
      (await Session.create({ userId: user._id, mode: SessionMode.SIMULATION }))
        ._id
    );

    const socket = await openSocket();
    send(socket, { type: 'INIT', sessionId, mode: SessionMode.SIMULATION });

    const error = await waitForStatus(socket, 'ERROR');
    expect(error.message).toMatch(/Access token required/i);
  });

  it('rejects an INIT whose token is not a valid access token', async () => {
    const { user } = await seedUser();
    const sessionId = String(
      (await Session.create({ userId: user._id, mode: SessionMode.SIMULATION }))
        ._id
    );

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: 'not.a.jwt',
      sessionId,
      mode: SessionMode.SIMULATION,
    });

    const error = await waitForStatus(socket, 'ERROR');
    expect(error.status).toBe('ERROR');
  });

  it('never starts a stream for a session owned by another user', async () => {
    const owner = await seedUser();
    const intruder = await seedUser({ email: 'intruder@example.com' });
    const sessionId = await createSession(owner.accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: intruder.accessToken,
      sessionId,
      mode: SessionMode.SIMULATION,
    });

    // A policy violation close, not an error frame: this is not a recoverable
    // condition the client should retry on the same socket.
    const closed = await waitForClose(socket);
    expect(closed.code).toBe(1008);
    expect(closed.reason).toMatch(/another user/i);
  });

  /**
   * The failure path writes session state, and `msg.sessionId` comes from the
   * caller. Scoping that write to a session the socket has proven a claim to
   * is what stops a stranger with any valid token marking an arbitrary session
   * errored, leaving the real owner a session they never ran already dead.
   */
  it(
    'leaves another user session untouched when a stranger tries to stream it',
    async () => {
      const owner = await seedUser();
      const intruder = await seedUser({ email: 'intruder@example.com' });
      const sessionId = await createSession(owner.accessToken);

      const socket = await openSocket();
      send(socket, {
        type: 'INIT',
        token: intruder.accessToken,
        sessionId,
        mode: SessionMode.SIMULATION,
      });
      await waitForClose(socket);
      await settle();

      const session = await Session.findById(sessionId);
      expect(session!.status).toBe(SessionStatus.PENDING);
    }
  );

  /**
   * The unauthenticated variant, and the sharper one: the same failure path
   * runs when authenticateSocketToken rejects, so without scoping, a client
   * that proves nothing at all could set any session id it can guess to ERROR.
   */
  it(
    'leaves a session untouched when an INIT carries no token',
    async () => {
      const { user } = await seedUser();
      const sessionId = String(
        (
          await Session.create({
            userId: user._id,
            mode: SessionMode.SIMULATION,
          })
        )._id
      );

      const socket = await openSocket();
      send(socket, { type: 'INIT', sessionId, mode: SessionMode.SIMULATION });
      await waitForStatus(socket, 'ERROR');
      await settle();

      const session = await Session.findById(sessionId);
      expect(session!.status).toBe(SessionStatus.PENDING);
    }
  );

  it('rejects an INIT naming a session that does not exist', async () => {
    const { accessToken } = await seedUser();

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId: '507f1f77bcf86cd799439011',
      mode: SessionMode.SIMULATION,
    });

    const error = await waitForStatus(socket, 'ERROR');
    expect(error.message).toMatch(/Unknown sessionId/i);
  });
});

describe('INIT handshake', () => {
  it('answers a valid INIT with STARTED naming the session', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.SIMULATION,
    });

    const started = await waitForStatus(socket, 'STARTED');
    expect(started.sessionId).toBe(sessionId);
  });

  it('describes the stream in the STARTED config so the client hardcodes nothing', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.SIMULATION,
    });

    const { config } = await waitForStatus(socket, 'STARTED');

    expect(config).toMatchObject({
      mode: SessionMode.SIMULATION,
      sampleRate: SAMPLE_RATE,
      packetSamples: PACKET_SAMPLES,
      epochSamples: SAMPLE_RATE * 4,
      stepSamples: SAMPLE_RATE * 1,
      speed: 1,
      labels: ['left_hand', 'right_hand', 'feet'],
      filters: { bandpassLow: 8, bandpassHigh: 30, notch: true },
    });
    expect(config.channelNames).toEqual(channelOrder);
  });

  it('promises ground truth for simulation, whose recording carries cues', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.SIMULATION,
    });

    const { config } = await waitForStatus(socket, 'STARTED');
    expect(config.hasGroundTruth).toBe(true);
  });

  it('denies ground truth for hardware, which has no cue events to score against', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.HARDWARE,
      hardwareWsUrl: 'ws://127.0.0.1:1/never',
    });

    const { config } = await waitForStatus(socket, 'STARTED');
    expect(config.hasGroundTruth).toBe(false);
  });

  it('moves the session from pending to active once the stream starts', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);
    expect((await Session.findById(sessionId))!.status).toBe(
      SessionStatus.PENDING
    );

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.SIMULATION,
    });
    await waitForStatus(socket, 'STARTED');

    const session = await Session.findById(sessionId);
    expect(session!.status).toBe(SessionStatus.ACTIVE);
    expect(session!.startTime).toBeInstanceOf(Date);
  });
});

describe('frame protocol', () => {
  it('closes a socket whose first frame is not INIT', async () => {
    const socket = await openSocket();
    send(socket, { type: 'CONTROL', notch: false });

    const closed = await waitForClose(socket);
    expect(closed.code).toBe(1003);
    expect(closed.reason).toMatch(/Expected INIT/i);
  });

  it('closes a socket that sends something that is not JSON', async () => {
    const socket = await openSocket();
    socket.send('<not json>');

    const closed = await waitForClose(socket);
    expect(closed.code).toBe(1003);
    expect(closed.reason).toMatch(/Invalid message/i);
  });

  it('answers a second INIT on the same socket with an error, not a restart', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    const init = {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.SIMULATION,
    };
    send(socket, init);
    await waitForStatus(socket, 'STARTED');

    send(socket, init);

    const error = await waitForStatus(socket, 'ERROR');
    expect(error.message).toMatch(/Expected CONTROL, received "INIT"/);
  });
});

/**
 * React 18 Strict Mode mounts an effect twice, so the dashboard opened a second
 * socket and INIT-ed the same session id while the first was already streaming.
 * The server's pending-status guard is what caught it, so it is worth pinning.
 */
describe('a second socket INIT-ing a session that has already started', () => {
  it('refuses to restart a session that has left pending status', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);
    const init = {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.SIMULATION,
    };

    const first = await openSocket();
    send(first, init);
    await waitForStatus(first, 'STARTED');

    const second = await openSocket();
    send(second, init);

    const error = await waitForStatus(second, 'ERROR');
    expect(error.message).toMatch(/already active and cannot be restarted/i);
  });

  it('closes the duplicate socket rather than leaving it half-connected', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);
    const init = {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.SIMULATION,
    };

    const first = await openSocket();
    send(first, init);
    await waitForStatus(first, 'STARTED');

    const second = await openSocket();
    send(second, init);

    const closed = await waitForClose(second);
    expect(closed.code).toBe(1011);
  });

  /**
   * The refused duplicate must not corrupt the run it was protecting. The
   * second socket is rejected while the first is still streaming, so if the
   * failure path wrote to that session it would read as failed for the rest of
   * the run — a client polling GET /sessions mid-stream would see a healthy
   * session as dead. This is the Strict-Mode double mount in the browser.
   */
  it(
    'leaves the running session active when the duplicate is refused',
    async () => {
      const { accessToken } = await seedUser();
      const sessionId = await createSession(accessToken);
      const init = {
        type: 'INIT',
        token: accessToken,
        sessionId,
        mode: SessionMode.SIMULATION,
      };

      const first = await openSocket();
      send(first, init);
      await waitForStatus(first, 'STARTED');

      const second = await openSocket();
      send(second, init);
      await waitForStatus(second, 'ERROR');
      await settle();

      const session = await Session.findById(sessionId);
      expect(session!.status).toBe(SessionStatus.ACTIVE);
      expect(session!.errorMessage).toBeUndefined();
    }
  );
});

describe('DATA_PACKET cadence', () => {
  // One stream feeds every assertion below. Each `it` re-running a 5 s capture
  // would pay 4 s of epoch latency again for nothing.
  let packets: Frame[];
  let started: Frame;

  beforeAll(async () => {
    const { accessToken } = await seedUser({ email: 'cadence@example.com' });
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.SIMULATION,
    });

    started = await waitForStatus(socket, 'STARTED');
    // Far enough to see two epochs close: 100 packets to the first, 25 to the
    // next, plus a few to prove the analysis fields drop off again.
    packets = await collectPackets(socket, PACKETS_TO_FIRST_EPOCH + 30);
    socket.terminate();
  }, 30000);

  it('starts the stream before any packet arrives', () => {
    expect(started.status).toBe('STARTED');
  });

  it('carries samples on every single packet, so the waveform never stalls', () => {
    expect(packets.every((packet) => Array.isArray(packet.samples))).toBe(true);
    expect(packets.every((packet) => packet.samples.length === 22)).toBe(true);
  });

  it('sends one packet per 10 samples across the whole montage', () => {
    expect(packets[0].samples).toHaveLength(channelOrder.length);
    expect(packets[0].samples[0]).toHaveLength(PACKET_SAMPLES);
    expect(packets[0].channelNames).toEqual(channelOrder);
  });

  it('omits psd, topographic and classification on packets between epochs', () => {
    const between = packets.slice(0, PACKETS_TO_FIRST_EPOCH - 1);
    expect(between).not.toHaveLength(0);
    expect(
      between.every(
        (packet) =>
          packet.psd === undefined &&
          packet.topographic === undefined &&
          packet.classification === undefined
      )
    ).toBe(true);
  });

  it('reports epochIndex -1 until the first epoch has closed', () => {
    expect(packets[0].epochIndex).toBe(-1);
    expect(packets[PACKETS_TO_FIRST_EPOCH - 2].epochIndex).toBe(-1);
  });

  it('closes the first epoch on the packet completing the 4 s window', () => {
    const first = packets.findIndex((packet) => packet.psd !== undefined);
    expect(first).toBe(PACKETS_TO_FIRST_EPOCH - 1);
  });

  it('attaches the full analysis to the packet that closes an epoch', () => {
    const closing = packets[PACKETS_TO_FIRST_EPOCH - 1];
    expect(closing.epochIndex).toBe(0);
    expect(closing.psd.freqs.length).toBeGreaterThan(0);
    expect(closing.psd.power).toHaveLength(closing.psd.freqs.length);
    expect(Object.keys(closing.topographic)).toEqual(channelOrder);
    expect(closing.classification.predictedClass).toBe(MILabel.LEFT_HAND);
    expect(Object.keys(closing.classification.allScores).sort()).toEqual([
      'feet',
      'left_hand',
      'right_hand',
    ]);
  });

  it('closes an epoch once every 25 packets thereafter, on the 1 s step', () => {
    const closers = packets
      .map((packet, index) => (packet.psd !== undefined ? index : -1))
      .filter((index) => index >= 0);

    expect(closers.length).toBeGreaterThanOrEqual(2);
    expect(closers[1] - closers[0]).toBe(PACKETS_PER_EPOCH_STEP);
  });

  it('advances the epoch index by one on each closing packet', () => {
    const closers = packets.filter((packet) => packet.psd !== undefined);
    expect(closers[0].epochIndex).toBe(0);
    expect(closers[1].epochIndex).toBe(1);
  });

  it('holds the last epoch index on the packets that follow it', () => {
    expect(packets[PACKETS_TO_FIRST_EPOCH].epochIndex).toBe(0);
    expect(packets[PACKETS_TO_FIRST_EPOCH + 1].psd).toBeUndefined();
  });

  it('timestamps packets in stream time, not wall-clock time', () => {
    // 10 samples at 250 Hz is 0.04 s into the recording. A Unix timestamp would
    // be ~1.7e9, so this also proves the mode is not falling back to Date.now().
    expect(packets[0].timestamp).toBeCloseTo(PACKET_SAMPLES / SAMPLE_RATE, 5);
    expect(packets[1].timestamp).toBeCloseTo((2 * PACKET_SAMPLES) / SAMPLE_RATE, 5);
    expect(packets[0].timestamp).toBeLessThan(1_000_000);
  });

  it('closes the first epoch exactly 4 s into stream time', () => {
    expect(packets[PACKETS_TO_FIRST_EPOCH - 1].timestamp).toBeCloseTo(4, 5);
  });

  it('rounds samples to three decimals to keep frames small', () => {
    const values = packets[0].samples.flat() as number[];
    expect(
      values.every((value) => Number(value.toFixed(3)) === value)
    ).toBe(true);
  });
});

describe('CONTROL frames', () => {
  it('retunes a live stream without the client reopening the socket', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.SIMULATION,
    });
    const { config } = await waitForStatus(socket, 'STARTED');
    expect(config.filters.notch).toBe(true);

    send(socket, { type: 'CONTROL', notch: false });

    const applied = await waitForStatus(socket, 'APPLIED');
    expect(applied.message).toMatch(/Filter settings updated/i);
    expect(applied.filters).toEqual({
      bandpassLow: 8,
      bandpassHigh: 30,
      notch: false,
    });

    // The point of CONTROL is that the session survives it.
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const after = await collectPackets(socket, 3);
    expect(after).toHaveLength(3);
  });

  it('moves a live stream onto the beta band without reopening the socket', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.SIMULATION,
    });
    await waitForStatus(socket, 'STARTED');

    // 13-30 is one of the five precomputed sections in BANDPASS_TABLE, so this
    // is a genuine retune rather than a no-op acknowledgement.
    send(socket, { type: 'CONTROL', bandpassLow: 13, bandpassHigh: 30 });

    const applied = await waitForStatus(socket, 'APPLIED');
    expect(applied.filters).toEqual({
      bandpassLow: 13,
      bandpassHigh: 30,
      notch: true,
    });

    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(await collectPackets(socket, 3)).toHaveLength(3);
  });

  it('reports an unsupported bandpass on the socket instead of tearing the session down', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.SIMULATION,
    });
    await waitForStatus(socket, 'STARTED');

    // BANDPASS_TABLE holds five sections; 7-31 is not one of them, and the
    // server refuses to silently substitute a neighbouring band.
    send(socket, { type: 'CONTROL', bandpassLow: 7, bandpassHigh: 31 });

    const error = await waitForStatus(socket, 'ERROR');
    expect(error.message).toMatch(/No precomputed bandpass section/i);

    // Rejected before mutating, so the old band is still the live one and the
    // client can keep showing it.
    expect(error.filters).toEqual({
      bandpassLow: 8,
      bandpassHigh: 30,
      notch: true,
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);

    const after = await collectPackets(socket, 3);
    expect(after).toHaveLength(3);
  });

  it('keeps streaming after a filter change, with the epoch pipeline intact', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.SIMULATION,
    });
    await waitForStatus(socket, 'STARTED');
    send(socket, { type: 'CONTROL', notch: false });
    await waitForStatus(socket, 'APPLIED');

    const closing = await waitFor(
      socket,
      (frame) => frame.type === 'DATA_PACKET' && frame.psd !== undefined
    );
    expect(closing.epochIndex).toBe(0);
    expect(closing.classification).toBeDefined();
  }, 30000);
});

describe('session lifecycle', () => {
  it('streams to the end of the recording and then reports COMPLETED', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.SIMULATION,
    });

    const completed = await waitForStatus(socket, 'COMPLETED', 25000);
    expect(completed.sessionId).toBe(sessionId);
  }, 30000);

  it('finalises the session document once the recording runs out', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.SIMULATION,
    });
    await waitForStatus(socket, 'COMPLETED', 25000);

    const session = await Session.findById(sessionId);
    expect(session!.status).toBe(SessionStatus.COMPLETED);
    expect(session!.endTime).toBeInstanceOf(Date);
    // 1500 samples: the first epoch closes at 1000, then one per 250-sample step.
    expect(session!.epochCount).toBe(3);
    expect(session!.meanConfidence).toBeCloseTo(0.9125, 3);
  }, 30000);

  it('persists one classification per closed epoch', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.SIMULATION,
    });
    await waitForStatus(socket, 'COMPLETED', 25000);

    const stored = await Classification.find({ sessionId }).sort({
      epochIndex: 1,
    });
    expect(stored).toHaveLength(3);
    expect(stored.map((row) => row.epochIndex)).toEqual([0, 1, 2]);
    expect(stored[0].features.length).toBe(4);
  }, 30000);

  it('reports an error frame when the mode is not one the server streams', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: 'telepathy',
    });

    const error = await waitForStatus(socket, 'ERROR');
    expect(error.message).toMatch(/Unknown session mode "telepathy"/);

    await settle();
    const session = await Session.findById(sessionId);
    expect(session!.status).toBe(SessionStatus.ERROR);
  });

  it('rejects a hardware INIT that names no headset URL', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.HARDWARE,
    });

    const error = await waitForStatus(socket, 'ERROR');
    expect(error.message).toMatch(/Hardware sessions require a hardwareWsUrl/i);
  });

  it('rejects an upload INIT that names no dataset', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.UPLOAD,
    });

    const error = await waitForStatus(socket, 'ERROR');
    expect(error.message).toMatch(/Upload sessions require a datasetId/i);
  });

  it('records the failure on the session so the user can see why it stopped', async () => {
    const { accessToken } = await seedUser();
    const sessionId = await createSession(accessToken);

    const socket = await openSocket();
    send(socket, {
      type: 'INIT',
      token: accessToken,
      sessionId,
      mode: SessionMode.UPLOAD,
    });
    await waitForStatus(socket, 'ERROR');
    await settle();

    const session = await Session.findById(sessionId);
    expect(session!.status).toBe(SessionStatus.ERROR);
    expect(session!.errorMessage).toMatch(/datasetId/i);
  });
});

describe('connection bookkeeping', () => {
  it('counts a socket while it is attached and forgets it once closed', async () => {
    const before = manager.connectionCount;

    const socket = await openSocket();
    expect(manager.connectionCount).toBe(before + 1);

    socket.close();
    await waitForClose(socket);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(manager.connectionCount).toBe(before);
  });
});

/** The fixture directory the mock factory created. */
afterAll(() => {
  const dir = fixtureHome().__bciFixtureDir;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
