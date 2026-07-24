"""Loaded ONNX graphs, kept warm.

Creating an InferenceSession costs tens of milliseconds, which would dominate
the per-epoch budget if it happened per request. Sessions are therefore cached
for the process's lifetime and invalidated only when a retrain replaces the file
underneath them.
"""

from __future__ import annotations

import logging
import threading
import time

import numpy as np
import onnxruntime as ort

from . import config
from .montage import LABELS

log = logging.getLogger(__name__)


class ModelRegistry:
    def __init__(self) -> None:
        self._sessions: dict[str, ort.InferenceSession] = {}
        self._lock = threading.Lock()

    def available(self) -> list[str]:
        """Model ids with both artifacts present on disk.

        Both, not either: an ONNX graph whose CSP filters are missing cannot
        produce a prediction, and reporting it as loaded would let the server
        route traffic to it.
        """
        if not config.MODEL_DIR.exists():
            return []

        ids = []
        for path in sorted(config.MODEL_DIR.glob("csp_lda_*.onnx")):
            model_id = path.stem.removeprefix("csp_lda_")
            if config.csp_path(model_id).exists():
                ids.append(model_id)
        return ids

    def get(self, model_id: str) -> tuple[ort.InferenceSession, str]:
        """Resolve a session, falling back to the default model.

        A missing subject model is recoverable — the global model still decodes
        the same three classes. A missing default model is not.
        """
        resolved = model_id if config.model_path(model_id).exists() else config.DEFAULT_MODEL_ID

        with self._lock:
            session = self._sessions.get(resolved)
            if session is not None:
                return session, resolved

            path = config.model_path(resolved)
            if not path.exists():
                raise FileNotFoundError(
                    f"No model at {path}. Train one with "
                    f"`python train.py --subject {resolved} <recording.gdf>`."
                )

            session = ort.InferenceSession(
                str(path), providers=["CPUExecutionProvider"]
            )
            self._sessions[resolved] = session
            log.info("Loaded model '%s' from %s", resolved, path)
            return session, resolved

    def invalidate(self, model_id: str | None = None) -> None:
        """Drop cached sessions so a retrained model is picked up."""
        with self._lock:
            if model_id is None:
                self._sessions.clear()
            else:
                self._sessions.pop(model_id, None)

    def classify(self, features: list[float], subject_id: str) -> dict:
        session, resolved = self.get(subject_id)

        expected = session.get_inputs()[0].shape[-1]
        if isinstance(expected, int) and len(features) != expected:
            raise ValueError(
                f"Model '{resolved}' expects {expected} features, got {len(features)}"
            )

        tensor = np.asarray([features], dtype=np.float32)
        started = time.perf_counter()
        outputs = session.run(None, {session.get_inputs()[0].name: tensor})
        inference_ms = (time.perf_counter() - started) * 1000

        probabilities = _probabilities_from(outputs)
        index = int(np.argmax(probabilities))

        return {
            "predicted_class": LABELS[index] if index < len(LABELS) else "unknown",
            "confidence": float(probabilities[index]),
            "all_scores": {
                label: float(probabilities[i]) if i < len(probabilities) else 0.0
                for i, label in enumerate(LABELS)
            },
            "inference_ms": round(inference_ms, 3),
            "model_id": resolved,
        }


def _probabilities_from(outputs: list) -> np.ndarray:
    """Pull the probability vector out of an ONNX output list.

    Exports differ: with zipmap disabled the graph emits [label, probabilities]
    as tensors; with it enabled the second output is a list of dicts. Both are
    accepted so serving does not depend on how the model happened to be exported.
    """
    for out in outputs:
        if isinstance(out, list) and out and isinstance(out[0], dict):
            return np.asarray(list(out[0].values()), dtype=float)

    for out in outputs:
        array = np.asarray(out)
        if array.ndim == 2 and array.shape[0] == 1:
            return array[0].astype(float)

    raise ValueError("ONNX model returned no probability output")


registry = ModelRegistry()
