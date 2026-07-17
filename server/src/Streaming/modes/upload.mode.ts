import { WebSocket } from 'ws';
import { SignalProcessor } from '../../Signal_Processing/services/signalProcessor.service';
import type { Classifier } from '../../Classification/services/mlServiceClient.service';
import type { ClassificationResult } from '../../Classification/services/onnxClassifier.service';
import type { MILabel } from '../../Classification/models/classification.model';
import Dataset from '../../Datasets/models/dataset.model';
import {
  loadRecording,
  alignToMontage,
} from '../../Datasets/services/datasetLoader.service';
import { streamingConfig } from '../../config/streaming';
import {
  buildDataPacket,
  resolveTrueClass,
  Send,
} from '../services/packet.service';
import { NotFoundError, ForbiddenError } from '../../utils/customErrors';
import logger from '../../utils/logger';

/** Called once per classified epoch so the caller can persist it. */
export type EpochSink = (epoch: {
  epochIndex: number;
  epochTimestamp: number;
  classification: ClassificationResult;
  features: number[];
  trueClass?: MILabel;
}) => Promise<void> | void;

export interface UploadOptions {
  modelId?: string;
  onEpoch?: EpochSink;
  /** Playback speed relative to real time. */
  speed?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Default playback rate for file-backed analysis. */
export const UPLOAD_SPEED = 8;

/**
 * Analyse an uploaded recording end to end.
 *
 * Unlike simulation mode this is not rate-limited by an acquisition clock — the
 * file is already on disk, so there is no reason to make a user wait five
 * minutes to see the result of a five-minute recording. Packets are still
 * emitted incrementally so the dashboard animates rather than jumping to a
 * finished state, but the default pace is eight times real time.
 *
 * Because the stream is faster than the wall clock, every packet carries the
 * recording's own time base in `timestamp`. A session timer driven by
 * `Date.now()` on the client would disagree with the data; the STARTED frame
 * reports `speed` so the client can drive its clock from the stream instead.
 *
 * @param ws - The client socket.
 * @param processor - This session's signal processor.
 * @param classifier - The configured inference backend.
 * @param send - Writer for outbound frames.
 * @param datasetId - Dataset to analyse.
 * @param userId - Owner, checked against the dataset.
 * @param options - Model selection, pacing, and the persistence hook.
 */
export async function runUploadMode(
  ws: WebSocket,
  processor: SignalProcessor,
  classifier: Classifier,
  send: Send,
  datasetId: string,
  userId: string,
  options: UploadOptions = {}
): Promise<void> {
  const dataset = await Dataset.findById(datasetId);

  if (!dataset) {
    throw new NotFoundError('Dataset not found');
  }

  // The socket carries a token, but the dataset id arrives from the client, so
  // ownership is re-checked here rather than trusted from the INIT frame.
  if (String(dataset.userId) !== String(userId)) {
    throw new ForbiddenError('This dataset belongs to another user');
  }

  const recording = loadRecording(dataset.filePath);
  const { samples, channelNames, sampleRate } = alignToMontage(recording);

  const packet = streamingConfig.packetSamples;
  const total = samples[0].length;
  const speed = options.speed ?? UPLOAD_SPEED;
  const interval = speed > 0 ? (1000 * packet) / (sampleRate * speed) : 0;

  logger.info(
    `Upload analysis started: ${dataset.originalName}, ` +
      `${total} samples at ${sampleRate} Hz`
  );

  let epochIndex = -1;

  for (let position = 0; position < total; position += packet) {
    if (ws.readyState !== ws.OPEN) {
      logger.info(
        `Upload analysis stopped at epoch ${epochIndex} (client closed)`
      );
      return;
    }

    const started = Date.now();

    const end = Math.min(position + packet, total);
    const chunk = samples.map((channel) => channel.slice(position, end));

    const { filtered, analysis } = processor.process(chunk, channelNames);

    if (!analysis) {
      send(
        buildDataPacket({
          samples: filtered,
          channelNames,
          epochIndex,
          timestamp: end / sampleRate,
        })
      );
    } else {
      const classification = await classifier.classify(
        analysis.features,
        options.modelId ?? dataset.subjectId
      );

      epochIndex += 1;

      send(
        buildDataPacket({
          samples: filtered,
          channelNames,
          epochIndex,
          timestamp: end / sampleRate,
          processed: analysis,
          classification,
        })
      );

      await options.onEpoch?.({
        epochIndex,
        epochTimestamp: end / sampleRate,
        classification,
        features: analysis.features,
        trueClass: resolveTrueClass(recording.events, end, sampleRate),
      });
    }

    if (interval > 0) {
      await sleep(Math.max(0, interval - (Date.now() - started)));
    }
  }

  logger.info(
    `Upload analysis complete: ${dataset.originalName}, ${epochIndex + 1} epochs`
  );
}

export default runUploadMode;
