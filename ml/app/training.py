"""Fit CSP + LDA and export what the server needs to serve it.

Two artifacts come out of a run, and both must come from the same run:

* ``csp_{id}.json``     — the spatial filters, applied in TypeScript.
* ``csp_lda_{id}.onnx`` — the classifier, run by onnxruntime.

They are separate because skl2onnx cannot export MNE's CSP transformer, so the
projection stays outside the graph and only the log-variance features go in.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from mne.decoding import CSP
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.model_selection import StratifiedKFold, cross_val_score
from sklearn.pipeline import Pipeline

from . import config
from .montage import CHANNEL_ORDER, LABELS, N_CHANNELS
from .preprocessing import extract_epochs, load_recording, preprocess

log = logging.getLogger(__name__)

DEFAULT_COMPONENTS = 6


def _build_csp(n_components: int) -> CSP:
    # transform_into="average_power" with log=True is exactly
    # log(mean(projected**2)), which is what computeCSPFeatures reimplements in
    # features.service.ts. Changing either of these breaks that correspondence.
    return CSP(
        n_components=n_components,
        transform_into="average_power",
        log=True,
        norm_trace=False,
        reg=None,
    )


def load_dataset(
    gdf_paths: list[str | Path], notch: bool = True
) -> tuple[np.ndarray, np.ndarray]:
    """Load, filter and epoch one or more recordings into a single set."""
    all_x: list[np.ndarray] = []
    all_y: list[np.ndarray] = []

    for path in gdf_paths:
        data_uv, _, cues = load_recording(path)
        filtered = preprocess(data_uv, notch=notch)
        x, y = extract_epochs(filtered, cues)

        log.info("%s -> %d epochs", Path(path).name, len(y))
        all_x.append(x)
        all_y.append(y)

    x = np.concatenate(all_x, axis=0)
    y = np.concatenate(all_y, axis=0)

    counts = {LABELS[i]: int((y == i).sum()) for i in range(len(LABELS))}
    log.info("Dataset: %d epochs, %s", len(y), counts)

    if len(np.unique(y)) < len(LABELS):
        raise ValueError(
            f"Training needs all {len(LABELS)} classes, found {counts}"
        )

    return x, y


def _cross_validate(x: np.ndarray, y: np.ndarray, n_components: int) -> float:
    """Honest accuracy estimate: CSP is refitted inside every fold.

    Fitting CSP once on everything and cross-validating only the LDA would leak
    the test folds into the spatial filters and inflate the score.
    """
    pipeline = Pipeline(
        [("csp", _build_csp(n_components)), ("lda", LinearDiscriminantAnalysis())]
    )
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    scores = cross_val_score(pipeline, x, y, cv=cv, scoring="accuracy")

    log.info(
        "5-fold CV accuracy: %.3f +/- %.3f (chance = %.3f)",
        scores.mean(),
        scores.std(),
        1 / len(LABELS),
    )
    return float(scores.mean())


def _verify_feature_contract(
    csp: CSP, x: np.ndarray, n_components: int
) -> None:
    """Prove the server's formula reproduces MNE's transform.

    The server does not call MNE; it reimplements the projection in TypeScript
    from the exported filter matrix. This asserts the reimplementation and the
    original agree, so the check fails here at training time rather than
    manifesting as a quietly worse model in production.
    """
    filters = csp.filters_[:n_components]
    reference = csp.transform(x[:8])

    manual = np.empty_like(reference)
    for i, epoch in enumerate(x[:8]):
        projected = filters @ epoch
        power = np.mean(projected**2, axis=1)
        manual[i] = np.log(np.maximum(power, np.finfo(float).tiny))

    if not np.allclose(reference, manual, rtol=1e-9, atol=1e-9):
        worst = float(np.max(np.abs(reference - manual)))
        raise AssertionError(
            "The exported CSP filters do not reproduce MNE's transform "
            f"(max deviation {worst:.3e}). The server would compute different "
            "features than this model was fitted on."
        )

    log.info("Feature contract verified against MNE's transform")


def _verify_onnx(onnx_bytes: bytes, lda, features: np.ndarray) -> None:
    """Round-trip the exported graph against scikit-learn's own output."""
    import onnxruntime as ort

    session = ort.InferenceSession(onnx_bytes, providers=["CPUExecutionProvider"])
    name = session.get_inputs()[0].name
    sample = features[:8].astype(np.float32)

    outputs = session.run(None, {name: sample})
    probabilities = next(
        (o for o in outputs if getattr(o, "ndim", 0) == 2), outputs[-1]
    )
    expected = lda.predict_proba(sample)

    if not np.allclose(probabilities, expected, atol=1e-4):
        worst = float(np.max(np.abs(np.asarray(probabilities) - expected)))
        raise AssertionError(
            f"Exported ONNX disagrees with scikit-learn (max {worst:.3e})"
        )

    log.info("ONNX export verified against scikit-learn")


def train_model(
    gdf_paths: list[str | Path],
    model_id: str = config.DEFAULT_MODEL_ID,
    n_components: int = DEFAULT_COMPONENTS,
    notch: bool = True,
) -> dict:
    """Fit, verify and export a model. Returns a summary of the run."""
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType

    x, y = load_dataset(gdf_paths, notch=notch)
    accuracy = _cross_validate(x, y, n_components)

    # Final fit on everything: the CV score above is the estimate, this is the
    # model that ships.
    csp = _build_csp(n_components)
    features = csp.fit_transform(x, y)

    lda = LinearDiscriminantAnalysis()
    lda.fit(features, y)

    # y is the index into LABELS, so classes_ must come back as 0..n-1 in order.
    # If it ever does not, the ONNX probability columns no longer line up with
    # the server's LABELS array and every prediction is mislabelled silently.
    if list(lda.classes_) != list(range(len(LABELS))):
        raise AssertionError(
            f"LDA classes_ is {list(lda.classes_)}, expected "
            f"{list(range(len(LABELS)))}. Probability columns would not match "
            f"the server's label order {LABELS}."
        )

    _verify_feature_contract(csp, x, n_components)

    onnx_model = convert_sklearn(
        lda,
        initial_types=[("features", FloatTensorType([None, n_components]))],
        # Emit probabilities as a plain tensor rather than a ZipMap sequence of
        # maps. The server handles both, but a tensor is what it looks for first.
        options={id(lda): {"zipmap": False}},
    )
    onnx_bytes = onnx_model.SerializeToString()
    _verify_onnx(onnx_bytes, lda, features)

    config.MODEL_DIR.mkdir(parents=True, exist_ok=True)

    model_file = config.model_path(model_id)
    model_file.write_bytes(onnx_bytes)

    csp_file = config.csp_path(model_id)
    csp_file.write_text(
        json.dumps(
            {
                "modelId": model_id,
                # [components][channels] — the server asserts the inner length
                # equals the montage size.
                "filters": csp.filters_[:n_components].tolist(),
                "channels": CHANNEL_ORDER,
                "labels": LABELS,
                "sampleRate": config.SAMPLE_RATE,
                "epochSamples": config.EPOCH_SAMPLES,
                "bandpass": [config.BANDPASS_LOW, config.BANDPASS_HIGH],
                "notch": config.NOTCH_FREQ if notch else None,
                "trainedAt": datetime.now(timezone.utc).isoformat(),
                "cvAccuracy": round(accuracy, 4),
                "sources": [Path(p).name for p in gdf_paths],
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    log.info("Wrote %s", model_file)
    log.info("Wrote %s", csp_file)

    return {
        "model_id": model_id,
        "epochs": int(len(y)),
        "n_components": n_components,
        "cv_accuracy": round(accuracy, 4),
        "onnx": str(model_file),
        "csp": str(csp_file),
    }


def print_filter_coefficients() -> None:
    """Emit the coefficient table the server pastes into filters.service.ts.

    Adding a band to the server means adding a precomputed section, and it must
    come from the same SciPy call this pipeline filters with. Printing it here
    keeps that copy honest.
    """
    from .preprocessing import design_bandpass, design_notch

    b, a = design_bandpass()
    print(f"'{config.BANDPASS_LOW:g}-{config.BANDPASS_HIGH:g}@{config.SAMPLE_RATE}': {{")
    print(f"  b: [{', '.join(f'{v:.10f}' for v in b)}],")
    print(f"  a: [{', '.join(f'{v:.10f}' for v in a)}],")
    print("},")

    bn, an = design_notch()
    print(f"'{config.NOTCH_FREQ:g}@{config.SAMPLE_RATE}': {{")
    print(f"  b: [{', '.join(f'{v:.10f}' for v in bn)}],")
    print(f"  a: [{', '.join(f'{v:.10f}' for v in an)}],")
    print("},")
