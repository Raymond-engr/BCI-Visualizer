import * as ort from 'onnxruntime-node';
import fs from 'fs';
import path from 'path';
import { classifierConfig } from '../../config/streaming';
import { MILabel } from '../models/classification.model';
import { AppError } from '../../utils/customErrors';
import logger from '../../utils/logger';

/**
 * Output order of the exported model. This must match the class order the
 * Python pipeline fitted with — skl2onnx emits probabilities positionally, so a
 * mismatch here silently mislabels every prediction rather than erroring.
 */
const LABELS: MILabel[] = [MILabel.LEFT_HAND, MILabel.RIGHT_HAND, MILabel.FEET];

export interface ClassificationResult {
  predictedClass: MILabel;
  confidence: number;
  allScores: Record<string, number>;
  inferenceMs: number;
  modelId: string;
}

/**
 * Local ONNX inference.
 *
 * The CSP + LDA pipeline is fitted in Python and exported through skl2onnx, so
 * the deployed server needs no Python runtime in the request path. Sessions are
 * loaded once at boot and reused; creating an InferenceSession costs tens of
 * milliseconds, which would blow the 50 ms per-epoch budget if done per call.
 */
export class ONNXClassifier {
  private sessions: Map<string, ort.InferenceSession> = new Map();
  private loading: Promise<void> | null = null;

  /**
   * Load one or more exported models from MODEL_DIR.
   * @param modelIds - Identifiers, e.g. ["global", "s1"].
   */
  async load(
    modelIds: string[] = [classifierConfig.defaultModelId]
  ): Promise<void> {
    for (const id of modelIds) {
      if (this.sessions.has(id)) continue;

      const modelPath = path.join(
        classifierConfig.modelDir,
        `csp_lda_${id}.onnx`
      );

      if (!fs.existsSync(modelPath)) {
        // A missing subject model is recoverable — inference falls back to the
        // global model. A missing global model is not, and is surfaced on the
        // first classify() call rather than crashing the process at boot.
        logger.warn(`[ONNX] Model not found, skipping: ${modelPath}`);
        continue;
      }

      try {
        const session = await ort.InferenceSession.create(modelPath, {
          executionProviders: ['cpu'],
          graphOptimizationLevel: 'all',
        });
        this.sessions.set(id, session);
        logger.info(`[ONNX] Loaded model "${id}" from ${modelPath}`);
      } catch (error: any) {
        logger.error(`[ONNX] Failed to load "${id}": ${error.message}`);
      }
    }

    logger.info(`[ONNX] ${this.sessions.size} model(s) ready`);
  }

  /** Ensure the default model is loaded exactly once, even under concurrency. */
  private async ensureLoaded(): Promise<void> {
    if (this.sessions.size) return;
    if (!this.loading) this.loading = this.load();
    await this.loading;
  }

  /** Identifiers of the models currently held in memory. */
  get loadedModels(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Classify one CSP feature vector.
   * @param features - Log-variance features from the signal pipeline.
   * @param modelId - Preferred model; falls back to the global model.
   * @returns The predicted class with per-class scores.
   */
  async classify(
    features: number[],
    modelId: string = classifierConfig.defaultModelId
  ): Promise<ClassificationResult> {
    await this.ensureLoaded();

    const resolvedId = this.sessions.has(modelId)
      ? modelId
      : classifierConfig.defaultModelId;
    const session = this.sessions.get(resolvedId);

    if (!session) {
      throw new AppError(
        `No ONNX model available. Expected ` +
          `${path.join(classifierConfig.modelDir, `csp_lda_${classifierConfig.defaultModelId}.onnx`)}. ` +
          'Train and export a model, or set USE_ML_SERVICE=true.',
        500
      );
    }

    const started = process.hrtime.bigint();

    const tensor = new ort.Tensor('float32', Float32Array.from(features), [
      1,
      features.length,
    ]);

    const inputName = session.inputNames[0];
    const output = await session.run({ [inputName]: tensor });

    const probabilities = this.readProbabilities(output);
    const inferenceMs = Number(process.hrtime.bigint() - started) / 1e6;

    let maxIndex = 0;
    for (let i = 1; i < probabilities.length; i++) {
      if (probabilities[i] > probabilities[maxIndex]) maxIndex = i;
    }

    return {
      predictedClass: LABELS[maxIndex] ?? MILabel.UNKNOWN,
      confidence: probabilities[maxIndex] ?? 0,
      allScores: Object.fromEntries(
        LABELS.map((label, i) => [label, probabilities[i] ?? 0])
      ),
      inferenceMs: Number(inferenceMs.toFixed(3)),
      modelId: resolvedId,
    };
  }

  /**
   * Pull the probability vector out of an ONNX output map.
   *
   * skl2onnx emits the class probabilities in different shapes depending on the
   * final estimator: a plain tensor named "probabilities", or a sequence of
   * maps named "output_probability". Both are handled so the server does not
   * depend on how the model happened to be exported.
   */
  private readProbabilities(
    output: ort.InferenceSession.OnnxValueMapType
  ): number[] {
    const candidate =
      output['probabilities'] ??
      output['output_probability'] ??
      output['probability_tensor'] ??
      Object.values(output).find((value: any) => value?.data);

    if (!candidate) {
      throw new AppError('ONNX model returned no probability output', 500);
    }

    // The union of shapes onnxruntime can hand back is wider than what any one
    // export produces, so this narrows structurally rather than by type.
    const data: unknown = (candidate as any).data ?? candidate;

    // Sequence-of-maps form: a ZipMap layer yields one Map per sample.
    if (data instanceof Map) {
      return [...data.values()].map(Number);
    }
    if (Array.isArray(data) && data[0] instanceof Map) {
      return [...(data[0] as Map<unknown, unknown>).values()].map(Number);
    }

    return Array.from(data as ArrayLike<number>, Number);
  }
}

export default ONNXClassifier;
