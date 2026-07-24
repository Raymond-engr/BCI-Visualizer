"""FastAPI inference microservice.

This is the backend the Node server talks to when USE_ML_SERVICE=true. The
contract below is not a new design — it is what
``server/src/Classification/services/mlServiceClient.service.ts`` already calls,
reproduced exactly. Renaming a field here breaks that client silently, because
axios will happily hand back a response whose keys nobody reads.

The trade this path makes: a network hop per epoch costs a few milliseconds, but
models can be retrained and swapped without redeploying the Node server, and
estimators skl2onnx cannot export stay usable.

Note the division of labour — the Node server applies the CSP projection itself
and posts the resulting log-variance features. This service classifies feature
vectors; it never sees raw EEG.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from . import config
from .montage import LABELS
from .registry import registry

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
log = logging.getLogger(__name__)

app = FastAPI(
    title="BCI Visualizer — ML Service",
    description="CSP+LDA inference and training for Motor Imagery decoding.",
    version="1.0.0",
)


class ClassifyRequest(BaseModel):
    features: list[float] = Field(..., min_length=1)
    subject_id: str = config.DEFAULT_MODEL_ID


class ClassifyResponse(BaseModel):
    predicted_class: str
    confidence: float
    all_scores: dict[str, float]
    inference_ms: float
    model_id: str


class HealthResponse(BaseModel):
    status: str
    models_loaded: list[str]
    model_dir: str
    labels: list[str]
    sample_rate: int


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Liveness plus the model inventory.

    The Node client reads `models_loaded` on startup to log what this service
    can serve, so it lists what is on disk rather than what happens to be warm
    in memory.
    """
    return HealthResponse(
        status="ok",
        models_loaded=registry.available(),
        model_dir=str(config.MODEL_DIR),
        labels=LABELS,
        sample_rate=config.SAMPLE_RATE,
    )


@app.post("/classify", response_model=ClassifyResponse)
def classify(request: ClassifyRequest) -> ClassifyResponse:
    try:
        result = registry.classify(request.features, request.subject_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    return ClassifyResponse(**result)


class TrainResponse(BaseModel):
    status: str
    subject_id: str
    gdf_path: str


@app.post("/train/{subject_id}", response_model=TrainResponse, status_code=202)
def train(
    subject_id: str,
    background: BackgroundTasks,
    gdf_path: str = Query(..., description="Absolute path to the training recording"),
) -> TrainResponse:
    """Kick off a training run and return immediately.

    Fitting CSP over a full session takes tens of seconds, well past the Node
    client's 5 s timeout, so the work is handed to a background task and the
    caller gets a 202. Progress lands in this service's log.
    """
    path = Path(gdf_path)
    if not path.exists():
        raise HTTPException(
            status_code=400, detail=f"Recording not found: {gdf_path}"
        )

    background.add_task(_run_training, subject_id, path)

    return TrainResponse(status="accepted", subject_id=subject_id, gdf_path=str(path))


def _run_training(subject_id: str, path: Path) -> None:
    # Imported here rather than at module scope: training pulls in MNE and
    # scikit-learn, which would add seconds to the startup of a service whose
    # main job is inference.
    from .training import train_model

    try:
        summary = train_model([path], model_id=subject_id)
        # The freshly written file must replace whatever this process already
        # had open for that id.
        registry.invalidate(subject_id)
        log.info("Training complete for '%s': %s", subject_id, summary)
    except Exception as error:  # noqa: BLE001 - background task must not die silently
        log.exception("Training failed for '%s': %s", subject_id, error)


def run() -> None:
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=config.PORT)


if __name__ == "__main__":
    run()
