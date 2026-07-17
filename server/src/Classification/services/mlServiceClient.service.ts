import axios, { AxiosInstance } from 'axios';
import { classifierConfig } from '../../config/streaming';
import { MILabel } from '../models/classification.model';
import { ExternalServiceAPIError } from '../../utils/customErrors';
import logger from '../../utils/logger';
import { ONNXClassifier, ClassificationResult } from './onnxClassifier.service';

/**
 * Any component that can turn a feature vector into a prediction. Both backends
 * satisfy it, so callers never branch on which one is configured.
 */
export interface Classifier {
  classify(features: number[], modelId?: string): Promise<ClassificationResult>;
  load(modelIds?: string[]): Promise<void>;
  readonly loadedModels: string[];
}

type MLClassifyResponse = {
  predicted_class: string;
  confidence: number;
  all_scores: Record<string, number>;
  inference_ms: number;
};

/**
 * HTTP client for the Python FastAPI microservice.
 *
 * Selected when USE_ML_SERVICE=true. The trade is latency for flexibility: a
 * network hop per epoch costs a few milliseconds, but models can be retrained
 * and hot-swapped without redeploying this server, and estimators that skl2onnx
 * cannot export stay usable.
 */
export class MLServiceClient implements Classifier {
  private readonly http: AxiosInstance;
  private available: string[] = [];

  constructor(baseURL: string = classifierConfig.mlServiceUrl) {
    this.http = axios.create({
      baseURL,
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Confirm the service is reachable and record which models it holds.
   * Failure is logged rather than thrown: the service may simply not be up yet,
   * and the first classify() call will surface a clearer error if it never is.
   */
  async load(): Promise<void> {
    try {
      const { data } = await this.http.get('/health');
      this.available = data?.models_loaded ?? [];
      logger.info(
        `[ML] Service healthy at ${this.http.defaults.baseURL}, ` +
          `models: ${this.available.join(', ') || 'none'}`
      );
    } catch (error: any) {
      logger.warn(
        `[ML] Health check failed for ${this.http.defaults.baseURL}: ${error.message}`
      );
    }
  }

  get loadedModels(): string[] {
    return this.available;
  }

  async classify(
    features: number[],
    modelId: string = classifierConfig.defaultModelId
  ): Promise<ClassificationResult> {
    try {
      const { data } = await this.http.post<MLClassifyResponse>('/classify', {
        features,
        subject_id: modelId,
      });

      return {
        predictedClass: (data.predicted_class as MILabel) ?? MILabel.UNKNOWN,
        confidence: data.confidence,
        allScores: data.all_scores,
        inferenceMs: data.inference_ms,
        modelId,
      };
    } catch (error: any) {
      const status = error.response?.status ?? 503;
      throw new ExternalServiceAPIError(
        `ML service classification failed: ${error.message}`,
        status,
        error.response?.data
      );
    }
  }

  /**
   * Kick off subject-specific training on the microservice.
   * @param subjectId - Subject identifier the model will be saved under.
   * @param gdfPath - Absolute path to the training recording.
   */
  async train(subjectId: string, gdfPath: string): Promise<void> {
    try {
      await this.http.post(`/train/${subjectId}`, null, {
        params: { gdf_path: gdfPath },
      });
      logger.info(`[ML] Training started for subject "${subjectId}"`);
    } catch (error: any) {
      throw new ExternalServiceAPIError(
        `ML service training request failed: ${error.message}`,
        error.response?.status ?? 503,
        error.response?.data
      );
    }
  }
}

let instance: Classifier | null = null;

/**
 * Resolve the configured inference backend, creating it on first use.
 * The classifier is a process-level singleton because both backends hold
 * expensive setup — loaded ONNX graphs, a keep-alive HTTP agent — that should
 * be shared across every WebSocket session.
 */
export function getClassifier(): Classifier {
  if (!instance) {
    instance = classifierConfig.useMLService
      ? new MLServiceClient()
      : new ONNXClassifier();
  }
  return instance;
}

/** Replace the backend. Used by tests. */
export function setClassifier(classifier: Classifier | null): void {
  instance = classifier;
}

export default MLServiceClient;
