"""The montage contract.

This mirrors ``server/src/utils/montage.ts``. CSP filters are indexed by
position, so this ordering is the contract between the training pipeline, the
exported filter matrix, and the server that later applies it. Reordering this
list without retraining silently permutes every spatial filter.
"""

from __future__ import annotations

# BCI Competition IV Dataset 2a — 22 EEG electrodes over the sensorimotor
# cortex, in the order the GDF channel table stores them.
CHANNEL_ORDER: list[str] = [
    "Fz",
    "FC3", "FC1", "FCz", "FC2", "FC4",
    "C5", "C3", "C1", "Cz", "C2", "C4", "C6",
    "CP3", "CP1", "CPz", "CP2", "CP4",
    "P1", "Pz", "P2",
    "POz",
]

N_CHANNELS: int = len(CHANNEL_ORDER)

# Output order of the exported model.
#
# skl2onnx emits probabilities positionally, in `classes_` order, and the
# server reads them positionally against this same list. Fitting on the raw
# string labels would sort them alphabetically — feet, left_hand, right_hand —
# and every prediction would be mislabelled without any error being raised.
# Training therefore encodes y as the index into this list.
LABELS: list[str] = ["left_hand", "right_hand", "feet"]

# GDF cue codes used by Dataset 2a. 772 (tongue) is deliberately absent: the
# recordings carry it, but nothing here is trained to predict it, so those
# trials are dropped rather than mislabelled.
CUE_CODES: dict[str, str] = {
    "769": "left_hand",
    "770": "right_hand",
    "771": "feet",
}


def label_index(label: str) -> int:
    return LABELS.index(label)
