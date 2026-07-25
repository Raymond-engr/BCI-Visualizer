"""Recording ingest, filtering, and epoching.

Everything here exists to produce, in Python, byte-for-byte the same signal the
Node server produces at inference time. Any divergence — units, filter phase,
channel order, window length — shifts the CSP feature distribution away from
what the LDA was fitted on. That failure is silent: no error, just quietly worse
predictions.
"""

from __future__ import annotations

import logging
from pathlib import Path

import mne
import numpy as np
from scipy.signal import butter, iirnotch, lfilter

from . import config
from .montage import CHANNEL_ORDER, CUE_CODES, N_CHANNELS, label_index

log = logging.getLogger(__name__)

# EEG in microvolts sits here. Well outside it and the units are wrong, which is
# the one preprocessing bug that produces a plausible-looking model that cannot
# work in production.
PLAUSIBLE_RMS_UV = (0.5, 500.0)


def design_bandpass(
    low: float = config.BANDPASS_LOW,
    high: float = config.BANDPASS_HIGH,
    fs: int = config.SAMPLE_RATE,
) -> tuple[np.ndarray, np.ndarray]:
    """The exact call whose output is pasted into the server's BANDPASS_TABLE."""
    return butter(config.BANDPASS_ORDER, [low, high], btype="band", fs=fs)


def design_notch(
    freq: float = config.NOTCH_FREQ,
    fs: int = config.SAMPLE_RATE,
    q: float = config.NOTCH_Q,
) -> tuple[np.ndarray, np.ndarray]:
    """The exact call whose output is pasted into the server's NOTCH_TABLE."""
    return iirnotch(freq, q, fs)


def apply_causal(data: np.ndarray, b: np.ndarray, a: np.ndarray) -> np.ndarray:
    """Filter forwards only, along the time axis.

    ``lfilter``, never ``filtfilt``. The server filters a live stream sample by
    sample, carrying the delay line between packets, which is causal by
    necessity — it cannot see the future. Training with a zero-phase filtfilt
    would fit CSP on signals whose phase the server can never reproduce.
    """
    return lfilter(b, a, data, axis=-1)


def preprocess(data_uv: np.ndarray, notch: bool = True) -> np.ndarray:
    """Bandpass, then optionally notch — the server's order of operations."""
    b, a = design_bandpass()
    out = apply_causal(data_uv, b, a)

    if notch:
        bn, an = design_notch()
        out = apply_causal(out, bn, an)

    return out


def load_recording(path: str | Path) -> tuple[np.ndarray, int, np.ndarray]:
    """Read a BCI Competition IV 2a GDF into montage order, in microvolts.

    Returns (data, sample_rate, cue_events), where ``data`` is [channel][sample]
    and ``cue_events`` is [[sample, label_index], ...].
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Recording not found: {path}")

    raw = mne.io.read_raw_gdf(str(path), preload=True, verbose="ERROR")

    # The server drops EOG by name and maps whatever remains onto the montage by
    # position, because BioSig writes most of the strip as "EEG-0", "EEG-1"
    # rather than as electrode names. Matching that rule here is what keeps the
    # two channel orderings identical.
    eeg_names = [n for n in raw.ch_names if not n.upper().startswith("EOG")]

    if len(eeg_names) != N_CHANNELS:
        raise ValueError(
            f"Expected {N_CHANNELS} non-EOG channels to map onto the montage, "
            f"found {len(eeg_names)} in {path.name}: {eeg_names}"
        )

    raw.pick(eeg_names)
    raw.rename_channels(dict(zip(eeg_names, CHANNEL_ORDER)))

    sfreq = int(round(raw.info["sfreq"]))
    if sfreq != config.SAMPLE_RATE:
        raise ValueError(
            f"{path.name} is {sfreq} Hz but this pipeline is configured for "
            f"{config.SAMPLE_RATE} Hz. The filter coefficients are keyed by "
            "sample rate and cannot be reused across rates."
        )

    # MNE returns SI units (volts); the server's GDF parser returns the header's
    # physical units, which for Dataset 2a is microvolts. CSP features are
    # log-power, so a units mismatch adds a constant offset to every feature —
    # which LDA, being affine, turns into a shifted decision boundary rather
    # than a harmless rescale.
    data_uv = raw.get_data() * 1e6

    # Dataset 2a marks rejected segments as NaN. Left alone they propagate
    # through the IIR delay line and poison every subsequent sample.
    nan_count = int(np.isnan(data_uv).sum())
    if nan_count:
        log.warning(
            "%s contains %d NaN samples (rejected segments); zero-filling them",
            path.name,
            nan_count,
        )
        data_uv = np.nan_to_num(data_uv, nan=0.0)

    rms = float(np.sqrt(np.mean(np.square(data_uv))))
    if not PLAUSIBLE_RMS_UV[0] <= rms <= PLAUSIBLE_RMS_UV[1]:
        log.warning(
            "Signal RMS is %.4g uV, outside the plausible range %s. The units "
            "are probably wrong, which will train a model the server cannot use.",
            rms,
            PLAUSIBLE_RMS_UV,
        )

    return data_uv, sfreq, _cue_events(raw)


def _cue_events(raw: mne.io.BaseRaw) -> np.ndarray:
    """Extract [[sample, label_index], ...] for the three cues we decode."""
    events, event_id = mne.events_from_annotations(raw, verbose="ERROR")

    # event_id maps the annotation's description ("769") to the integer code MNE
    # assigned it, which is not the GDF code itself.
    wanted = {
        event_id[desc]: label_index(label)
        for desc, label in CUE_CODES.items()
        if desc in event_id
    }

    if not wanted:
        raise ValueError(
            "No motor-imagery cue events (769/770/771) found. Evaluation files "
            "(A0xE.gdf) store cues as 783 with the labels in a separate .mat, "
            "so train on the T files."
        )

    rows = [
        [int(sample) - int(raw.first_samp), wanted[int(code)]]
        for sample, _, code in events
        if int(code) in wanted
    ]

    return np.asarray(rows, dtype=int)


def extract_epochs(
    data_uv: np.ndarray,
    cue_events: np.ndarray,
    epoch_samples: int = config.EPOCH_SAMPLES,
) -> tuple[np.ndarray, np.ndarray]:
    """Cut one epoch per cue, starting at cue onset.

    The window starts at the cue and runs for the epoch length, which is the
    same span the server attributes to a cue when it resolves ground truth.

    Returns (X, y) with X shaped [epoch][channel][sample].
    """
    total = data_uv.shape[1]
    epochs: list[np.ndarray] = []
    labels: list[int] = []

    for onset, label in cue_events:
        end = onset + epoch_samples
        if onset < 0 or end > total:
            continue
        epochs.append(data_uv[:, onset:end])
        labels.append(label)

    if not epochs:
        raise ValueError("No cue fell entirely inside the recording")

    return np.asarray(epochs, dtype=np.float64), np.asarray(labels, dtype=int)
