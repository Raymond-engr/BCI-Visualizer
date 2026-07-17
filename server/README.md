# BCI Visualizer — Server

Backend for the Web-Based Brain-Computer Interface Motor Imagery EEG
Visualizer. It ingests EEG recordings, filters and epochs them, extracts CSP
features, classifies each epoch against an exported model, and streams the
waveform, spectrum, topography and prediction to the dashboard over a
WebSocket.

Node.js 18+ / TypeScript / Express 5 / MongoDB / `ws` / onnxruntime-node.

---

## Quick start

```bash
npm install
cp .env.example .env        # then fill in MONGODB_URI and the JWT secrets
npm run seed:admin          # creates the first administrator
npm run verify:reference    # confirms the simulation recording parses
npm run dev
```

| URL | |
| --- | --- |
| `http://localhost:5000/api/v1` | REST API |
| `http://localhost:5000/api-docs` | Swagger UI |
| `ws://localhost:5000/ws/stream` | Streaming socket |

`npm test` runs the suite. `npm run build && npm start` runs the compiled
server.

> **Note on `npm install`:** `onnxruntime-node` downloads a native binary from
> nuget.org during postinstall. On a network that blocks it, install with
> `--ignore-scripts` and set `USE_ML_SERVICE=true` to classify through the
> Python service instead.

---

## What the pipeline does

```
recording ─→ bandpass 8–30 Hz ─→ notch 50 Hz ─→ epoch buffer ─→ CSP ─→ LDA ─→ packet
             (Butterworth, IIR)   (optional)     4 s / 1 s hop    (JSON)  (ONNX)
```

Every second, the buffer yields a 4-second window (75% overlap with the last
one), which becomes one classification and one `DATA_PACKET` on the socket.

**Three classes: `left_hand`, `right_hand`, `feet`.** BCI Competition IV
Dataset 2a records a fourth — tongue — and the parser reads its cue events, but
nothing here is trained to predict it. Its scalp signature is centro-frontal
and overlaps heavily with jaw EMG, making it the weakest of the four on a
C3/Cz/C4 sensorimotor montage. Excluding it leaves a cleanly lateralised
problem (left / right / bilateral-central) and lifts chance from 25% to 33.3%.
Epochs cued 772 resolve to no true class, so they are excluded from the
accuracy denominator rather than counted as errors.

### Three source modes, one packet shape

| Mode | Source | Pacing |
| --- | --- | --- |
| `simulation` | Bundled reference recording | Real time, as if live |
| `upload` | A recording the user uploaded | 8× real time by default |
| `hardware` | An external bridge over WebSocket | Whatever the device sends |

The frontend cannot tell them apart: same `INIT` handshake, same
`DATA_PACKET`. That is what makes the whole dashboard demonstrable without an
EEG cap.

Hardware mode does not talk to a headset directly — serial and Bluetooth access
is not something a containerised server has. A small local bridge process owns
the device and re-publishes frames over WebSocket; this server consumes that.

---

## Two decisions worth knowing about

**Filter coefficients are precomputed, not designed at runtime.** Filter
*design* is not reimplemented in TypeScript. The sections in
`filters.service.ts` were computed with SciPy and pasted in verbatim:

```python
from scipy.signal import butter, iirnotch
butter(2, [8, 30], btype='band', fs=250)
iirnotch(50.0, 35.0, 250)
```

This guarantees the server filters a sample exactly the way the Python training
pipeline filtered it. A mismatch would silently shift the CSP feature
distribution away from what the model was fitted on — no error, just quietly
worse predictions. The cost is that only the bands in the table are available,
which is why `PUT /preferences` rejects anything else instead of substituting a
near-enough filter.

**CSP filters live outside the ONNX graph.** skl2onnx cannot export MNE's CSP
transformer, so the training pipeline writes `csp_{modelId}.json` next to
`csp_lda_{modelId}.onnx`. The spatial projection is applied in TypeScript and
only the log-variance features go into the graph. Both files must be present in
`MODEL_DIR` and must come from the same training run.

---

## WebSocket protocol

Create the session over REST first, then open the socket. Doing it in that
order means an aborted socket still leaves a session the user can see, rather
than a silent no-op.

```jsonc
// 1. POST /api/v1/sessions -> { data: { _id: "65f..." } }
// 2. Open ws://localhost:5000/ws/stream, then send:
{
  "type": "INIT",
  "token": "<access token>",   // a socket carries no Authorization header
  "sessionId": "65f...",
  "mode": "simulation",
  "datasetId": "65a...",       // upload mode only
  "hardwareWsUrl": "ws://...", // hardware mode only
  "notch": true
}
```

The server replies `STATUS: STARTED` carrying a `config` block that describes
the stream — sample rate, channel names, class labels, playback speed, and
whether ground truth exists — so the client never hardcodes the montage. Then a
stream of packets, then `STATUS: COMPLETED`, or `STATUS: ERROR` with a message.

### Two rates, one packet type

**Waveform and classification move at different rates and the packet reflects
that.** Samples arrive every 40 ms (25 Hz). An epoch only closes once per
second, so `psd`, `topographic` and `classification` appear on roughly 1 packet
in 25 and are **absent from the rest**. The client keeps the last analysis it
saw and renders the waveform continuously underneath.

Fusing the two was the original design and it was wrong: because analysis
gated the send, 24 of every 25 packets were dropped and the client received
about 4% of the signal. `tests/signalProcessor.test.ts` guards against that
regression.

```jsonc
// The common case: 24 of every 25 packets.
{
  "type": "DATA_PACKET",
  "timestamp": 1718030400.25,
  "samples": [[12.481, 11.203]],   // [channel][sample], filtered, 3 dp
  "channelNames": ["Fz", "FC3", "..."],
  "epochIndex": 42                 // last completed epoch; -1 before the first
}

// On an epoch boundary, the same packet plus the analysis fields.
{
  "type": "DATA_PACKET",
  "timestamp": 1718030401.25,
  "samples": [[12.900, 13.114]],
  "channelNames": ["Fz", "FC3", "..."],
  "epochIndex": 43,
  "psd": { "freqs": [8, 8.5], "power": [1.2043, 1.9922] },
  "topographic": { "C3": -2.14, "Cz": 0.31, "C4": 1.88 },
  "classification": {
    "predictedClass": "left_hand",
    "confidence": 0.8123,
    "allScores": { "left_hand": 0.8123, "right_hand": 0.1201, "feet": 0.0676 }
  }
}
```

Sample values are rounded to three decimals. At 22 channels and 25 packets a
second the float representation dominates the wire cost, and sub-millivolt
precision is well below what a waveform trace can render.

### Retuning a live session

The dashboard's bandpass inputs and notch toggle act on a running stream. Send
a `CONTROL` frame; do not reopen the socket.

```jsonc
{ "type": "CONTROL", "notch": false }
{ "type": "CONTROL", "bandpassLow": 13, "bandpassHigh": 30 }
```

The server replies `STATUS: APPLIED` with the settings now in force. An
unsupported band is rejected **before** any state changes, so the stream
continues on the previous filter and the reply reports the unchanged values —
a bad input never kills a session.

### `timestamp` is stream time, not wall time

Upload mode replays at 8× real time by default (`config.speed`). A session
clock driven by `Date.now()` will disagree with the data. Drive it from
`packet.timestamp`, which is always the recording's own time base.

---

## API

Everything is under `/api/v1`. All routes need `Authorization: Bearer <token>`
except `/health` and `/auth/register|login|refresh-token`. Full schemas at
`/api-docs`.

| | |
| --- | --- |
| `POST /auth/register` · `POST /auth/login` | Access token in the body, refresh token as an httpOnly cookie |
| `POST /auth/refresh-token` · `POST /auth/logout` · `GET /auth/verify-token` | |
| `POST /datasets/upload` | multipart `file`, `.gdf` or `.csv` |
| `GET /datasets` · `GET /datasets/:id` · `DELETE /datasets/:id` | |
| `POST /sessions` · `GET /sessions` · `GET /sessions/:id` · `DELETE /sessions/:id` | |
| `GET /sessions/:id/classifications` | Epoch-by-epoch log |
| `GET /results/:id/export` | CSV, streamed via cursor |
| `GET /results/:id/summary` | Accuracy, mean confidence, class breakdown |
| `GET /preferences` · `PUT /preferences` · `GET /preferences/options` | |

Session documents expose two virtuals so clients don't reimplement the same
branches: `sourceLabel` (`"Live Simulation"`, `"Hardware Stream"`, or the
dataset's filename) and `hasGroundTruth`, which is `false` for hardware
sessions. That second one matters — **a live headset emits no cue events, so
`accuracy` is permanently `null` for hardware**, not merely unmeasured yet.
Render a dash, not a spinner.

### On the scope of `/preferences`

Only settings the server actually acts on are persisted: the bandpass band, the
notch toggle, the default mode, and the default model. The design prototype
sketches several more — ICA artifact rejection, reduced motion, high-contrast
badges, refresh rate, headset auto-reconnect, impedance warnings, cloud sync.
Those are either purely presentational, and so belong in frontend state, or are
out of scope for this iteration. Storing them here would imply the pipeline
honours them when it does not.

---

## Layout

```
src/
├── Classification/          # ONNX inference and the ML-service client
│   ├── models/              #   classification.model.ts
│   └── services/            #   onnxClassifier, mlServiceClient
├── Datasets/                # Upload, parse, montage alignment
│   ├── controllers/ models/ routes/
│   └── services/            #   gdfParser, csvParser, datasetLoader
├── Signal_Processing/       # Filtering, epoching, features
│   └── services/            #   filters, epoch, features, signalProcessor
├── Streaming/               # The WebSocket layer
│   ├── modes/               #   simulation, upload, hardware
│   └── services/            #   sessionManager, packet
├── Sessions/                # Session lifecycle, results export
│   ├── controllers/ models/ routes/
├── Preferences/
│   ├── controllers/ models/ routes/
├── config/streaming.ts      # Rates, window sizes, model and upload config
├── controllers/             # auth.controller.ts
├── db/database.ts
├── middleware/              # auth, errorHandler, notFound, validateRequest, uploadDataset
├── model/user.model.ts
├── routes/                  # index.ts, auth.routes.ts, health.routes.ts
├── scripts/                 # createAdmin, verifyReferenceDataset
├── services/token.service.ts
├── types/index.ts
├── utils/                   # logger, customErrors, asyncHandler, montage, ...
├── uploads/datasets/        # Uploaded recordings (gitignored)
├── app.ts                   # Express wiring
└── index.ts                 # Boot: dirs, env, DB, HTTP + WS on one port
models/                      # csp_lda_{id}.onnx + csp_{id}.json
tests/                       # 95 unit tests
swagger.yaml
```

Feature folders mirror the conventions of the `ubjh-server` repository:
class-based controllers exported as instances, every handler wrapped in
`asyncHandler`, zod schemas declared inline in the route files, envalid for
environment validation, and the shared `utils/`.

---

## Configuration

See `.env.example`. The ones that matter:

| | |
| --- | --- |
| `PORT` | Default `5000`. REST and WebSocket share it. |
| `MONGODB_URI` | |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Access 15 min, refresh 7 days |
| `SAMPLE_RATE` | `250`. Must match the coefficient table. |
| `BANDPASS_LOW` / `BANDPASS_HIGH` / `NOTCH_FREQ` | Must resolve to a precomputed section |
| `MODEL_DIR` / `DEFAULT_MODEL_ID` | Where `csp_lda_*.onnx` and `csp_*.json` live |
| `USE_ML_SERVICE` | `false` uses local ONNX; `true` forwards to the Python service |
| `ML_SERVICE_URL` | Only read when `USE_ML_SERVICE=true` |
| `REFERENCE_DATASET_PATH` | The recording simulation mode replays |
| `MAX_UPLOAD_MB` | |

`validateEnv()` runs before the server binds, so a missing or malformed value
fails at boot rather than on the first request.

---

## Tests

```bash
npm test
npm run test:coverage
```

120 unit tests across the filters, the epoch buffer and feature extraction, the
montage, the signal processor's output rates and live controls, the packet
builder and cue resolution, and the CSV parser.

The filter suite asserts the property the streaming design rests on: filtering a
signal in two chunks while carrying the delay line gives the same result, to six
decimal places, as filtering it in one pass — with a negative control showing
that discarding the state does visibly ring at the boundary. Writing these
turned up two real bugs: `applyIIR` returned `NaN` for order-0 sections, and the
CSV parser rejected valid single-column files because Papa Parse reports its
undetectable-delimiter *warning* through the same array as hard errors.

`signalProcessor.test.ts` pins the rate contract: every packet yields filtered
samples, analysis appears only on epoch boundaries, and the waveform:analysis
ratio stays above 10:1 — the assertion that would have caught the starvation
bug.
