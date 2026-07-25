# BCI Visualizer — ML

Fits the CSP + LDA model the dashboard decodes with, exports it for the Node
server, and optionally serves inference over HTTP.

Python 3.10+ / MNE / scikit-learn / skl2onnx / FastAPI.

---

## Quick start

```bash
python -m venv .venv && .venv/Scripts/activate   # Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env

python train.py path/to/A01T.gdf                 # writes the model into MODEL_DIR
```

That is the whole requirement for the Node server: `npm run dev` there will find
the two files and classify locally. The HTTP service below is optional.

```bash
uvicorn app.main:app --port 8000                 # only for USE_ML_SERVICE=true
```

### You have to supply the recording

The training data is **BCI Competition IV Dataset 2a** (`A01T.gdf` … `A09T.gdf`).
It is not redistributable — download it from
<https://www.bbci.de/competition/iv/> after registering.

Use the **T** files. The **E** files store every cue as code 783 with the true
labels in a separate `.mat`, so there is nothing to train against in the GDF
alone; `load_recording` says so rather than fitting on nothing.

The same `A01T.gdf` also backs simulation mode — point `REFERENCE_DATASET_PATH`
in `server/.env` at it.

---

## What a run produces

```
MODEL_DIR/
├── csp_lda_{id}.onnx   # the LDA, run by onnxruntime
└── csp_{id}.json       # the spatial filters, applied in TypeScript
```

**Both files, from the same run, or neither.** They are split because skl2onnx
cannot export MNE's `CSP` transformer: the projection stays outside the graph and
only the log-variance features go in. A mismatched pair is not a load error —
it is a model quietly running on the wrong spatial filters.

`--subject s1` exports as `csp_lda_s1.onnx`; the server selects it from a
dataset's `subjectId` and falls back to `global`.

---

## Four ways this can silently disagree with the server

None of these raise. Each one produces a model that loads, predicts, and is
wrong — which is why each has a guard.

**Units.** MNE returns volts; the server's GDF parser returns the header's
physical units, microvolts. CSP features are `log(power)`, so a 1e6 scale error
adds a constant to every feature — and LDA is affine, so that shifts the
decision boundary rather than cancelling out. Training multiplies by `1e6` and
warns if the resulting RMS leaves a plausible EEG range.

**Filter phase.** The server filters a live stream causally, carrying the delay
line across packets; it cannot see the future. Training therefore uses
`lfilter`, never `filtfilt`. A zero-phase fit would train on a signal the server
can never reproduce.

**Class order.** skl2onnx emits probability columns in `classes_` order, and the
server reads them positionally against `[left_hand, right_hand, feet]`. Fitting
on the string labels would sort them alphabetically to
`[feet, left_hand, right_hand]` and mislabel every prediction. Training encodes
`y` as the index into `LABELS` and asserts `classes_ == [0, 1, 2]`.

**Channel order.** BioSig writes most of the strip as `EEG-0`, `EEG-1`, so the
server drops EOG by name and maps whatever remains onto the montage *by
position*. `preprocessing.load_recording` applies the same rule. CSP filters are
indexed by position, so a permutation here scrambles every one of them.

Two further checks run on every training run: the exported filters are asserted
to reproduce MNE's own `transform` to 1e-9 using the server's formula, and the
exported ONNX graph is round-tripped against scikit-learn's `predict_proba`.

---

## Filter coefficients

The server does not design filters at runtime — it holds a table of sections
computed here and pasted in verbatim, which is what guarantees it filters a
sample exactly the way this pipeline did. To add a band, print the section and
paste it into `server/src/Signal_Processing/services/filters.service.ts`:

```bash
BANDPASS_LOW=13 BANDPASS_HIGH=30 python train.py --coefficients
```

The cost of that design is that only tabled bands exist, which is why
`PUT /preferences` rejects anything else instead of substituting a near-enough
filter.

---

## The HTTP service

Only used when `USE_ML_SERVICE=true` in `server/.env`. Default is `false`, which
runs onnxruntime inside the Node process and skips the network hop entirely.

It classifies **feature vectors, not EEG** — the Node server applies the CSP
projection itself and posts the log-variance features.

| | |
| --- | --- |
| `GET /health` | `{ status, models_loaded, model_dir, labels, sample_rate }` |
| `POST /classify` | `{ features, subject_id }` → `{ predicted_class, confidence, all_scores, inference_ms, model_id }` |
| `POST /train/{subject_id}?gdf_path=…` | 202, trains in the background |

These names are fixed by `mlServiceClient.service.ts`, which already calls them.
Renaming a field breaks that client silently — axios returns a response whose
keys nobody reads.

`/train` returns 202 rather than blocking: a fit takes tens of seconds and the
Node client times out at 5. Progress goes to this service's log, and the
retrained model replaces the cached session in place.

---

## Layout

```
ml/
├── app/
│   ├── config.py         # every value mirrors server/.env
│   ├── montage.py        # channel order + label order — the contracts
│   ├── preprocessing.py  # load, filter causally, epoch
│   ├── training.py       # fit, verify, export
│   ├── registry.py       # cached onnxruntime sessions
│   └── main.py           # FastAPI
├── train.py              # CLI
└── requirements.txt
```
