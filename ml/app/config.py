"""Runtime configuration.

Every value here has a counterpart in ``server/.env``. Where they disagree, the
two halves of the system quietly stop describing the same signal, so the
defaults are chosen to match ``server/src/config/streaming.ts`` exactly.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

_HERE = Path(__file__).resolve().parent.parent

MODEL_DIR: Path = Path(
    os.getenv("MODEL_DIR", str(_HERE.parent / "server" / "models"))
).resolve()

DEFAULT_MODEL_ID: str = os.getenv("DEFAULT_MODEL_ID", "global")

SAMPLE_RATE: int = int(os.getenv("SAMPLE_RATE", "250"))

BANDPASS_LOW: float = float(os.getenv("BANDPASS_LOW", "8"))
BANDPASS_HIGH: float = float(os.getenv("BANDPASS_HIGH", "30"))
NOTCH_FREQ: float = float(os.getenv("NOTCH_FREQ", "50"))

PORT: int = int(os.getenv("PORT", "8000"))

# 4 s at 250 Hz. Mirrors streamingConfig.epochSamples: the window CSP is fitted
# on has to be the window the server later hands to it.
EPOCH_SECONDS: float = 4.0
EPOCH_SAMPLES: int = int(SAMPLE_RATE * EPOCH_SECONDS)

# Q factor of the mains notch. Mirrors the iirnotch(50.0, 35.0, 250) call whose
# output is pasted into the server's filters.service.ts.
NOTCH_Q: float = 35.0

# Butterworth order passed to scipy.signal.butter. The server's coefficient
# table was generated with butter(2, ...), which yields a 4th-order section.
BANDPASS_ORDER: int = 2


def model_path(model_id: str) -> Path:
    return MODEL_DIR / f"csp_lda_{model_id}.onnx"


def csp_path(model_id: str) -> Path:
    return MODEL_DIR / f"csp_{model_id}.json"
