import { WebSocket } from 'ws';
import { SignalProcessor } from '../../Signal_Processing/services/signalProcessor.service';
import type { Classifier } from '../../Classification/services/mlServiceClient.service';
import { loadReferenceDataset } from '../../Datasets/services/datasetLoader.service';
import { streamingConfig } from '../../config/streaming';
import {
  buildDataPacket,
  resolveTrueClass,
  Send,
} from '../services/packet.service';
import logger from '../../utils/logger';
import type { EpochSink } from './upload.mode';

export interface SimulationOptions {
  modelId?: string;
  onEpoch?: EpochSink;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Replay the bundled reference recording at its original rate.
 *
 * The point of this mode is that it is indistinguishable from live hardware
 * from the frontend's perspective: same packet cadence, same message shape.
 * That makes the whole dashboard demonstrable without an EEG cap, which is the
 * mode most users will ever see.
 *
 * Pacing uses a self-scheduling loop rather than setInterval. A tick may await
 * an inference call, and setInterval would fire again underneath a tick that
 * had not finished, interleaving two packets on one processor; a loop that
 * sleeps for the remainder of its own budget cannot overlap by construction.
 * Subtracting the elapsed work from the sleep keeps the stream from drifting
 * behind real time over a long session.
 *
 * @param ws - The client socket.
 * @param processor - This session's signal processor.
 * @param classifier - The configured inference backend.
 * @param send - Writer for outbound frames.
 * @param options - Model selection and the per-epoch persistence hook.
 */
export async function runSimulationMode(
  ws: WebSocket,
  processor: SignalProcessor,
  classifier: Classifier,
  send: Send,
  options: SimulationOptions = {}
): Promise<void> {
  const { samples, channelNames, sampleRate, events } = loadReferenceDataset();

  const packet = streamingConfig.packetSamples;
  const interval = (1000 * packet) / sampleRate;
  const total = samples[0].length;

  let epochIndex = -1;

  for (let position = 0; position < total; position += packet) {
    if (ws.readyState !== ws.OPEN) {
      logger.info(`Simulation stopped at epoch ${epochIndex} (client closed)`);
      return;
    }

    const started = Date.now();

    const end = Math.min(position + packet, total);
    const chunk = samples.map((channel) => channel.slice(position, end));

    // Filtering and buffering run for every packet without exception. Skipping
    // one would leave a hole in the filter's input and a gap in the epoch,
    // which is why nothing here is guarded by a "busy" condition.
    const { filtered, analysis } = processor.process(chunk, channelNames);

    if (!analysis) {
      // No epoch closed on this packet, so the waveform advances on its own.
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
        options.modelId
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
        trueClass: resolveTrueClass(events, end, sampleRate),
      });
    }

    await sleep(Math.max(0, interval - (Date.now() - started)));
  }

  logger.info(`Simulation complete: ${epochIndex + 1} epochs`);
}

export default runSimulationMode;
