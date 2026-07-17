import { WebSocket } from 'ws';
import { SignalProcessor } from '../../Signal_Processing/services/signalProcessor.service';
import type { Classifier } from '../../Classification/services/mlServiceClient.service';
import { streamingConfig } from '../../config/streaming';
import { buildDataPacket, Send } from '../services/packet.service';
import { BadRequestError } from '../../utils/customErrors';
import logger from '../../utils/logger';
import type { EpochSink } from './upload.mode';

export interface HardwareOptions {
  modelId?: string;
  onEpoch?: EpochSink;
}

/** What a hardware bridge is expected to push. */
type BridgeFrame = {
  samples: number[][];
  channelNames?: string[];
  timestamp?: number;
};

/**
 * Bridge a live headset into the same pipeline the other two modes use.
 *
 * The server does not talk to an OpenBCI board or a BLE headset directly —
 * that requires serial and Bluetooth access a containerised server does not
 * have. Instead a small local bridge process owns the device and re-publishes
 * frames over WebSocket, and this mode consumes that stream. The device-facing
 * complexity stays on the machine physically attached to the hardware, and this
 * server keeps a single uniform input shape.
 *
 * A live headset carries no cue events, so nothing in this mode resolves a true
 * class. Sessions recorded here finish with a null accuracy by construction:
 * there is no ground truth to score against, and reporting a number anyway
 * would be inventing one.
 *
 * @param ws - The client socket.
 * @param processor - This session's signal processor.
 * @param classifier - The configured inference backend.
 * @param send - Writer for outbound frames.
 * @param bridgeUrl - WebSocket URL of the hardware bridge.
 * @param options - Model selection and the persistence hook.
 */
export function runHardwareMode(
  ws: WebSocket,
  processor: SignalProcessor,
  classifier: Classifier,
  send: Send,
  bridgeUrl: string,
  options: HardwareOptions = {}
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(bridgeUrl);
    } catch {
      return reject(
        new BadRequestError(`Invalid hardware bridge URL: ${bridgeUrl}`)
      );
    }

    if (!['ws:', 'wss:'].includes(url.protocol)) {
      return reject(
        new BadRequestError('Hardware bridge URL must use ws:// or wss://')
      );
    }

    const bridge = new WebSocket(bridgeUrl, { handshakeTimeout: 5000 });

    let epochIndex = -1;
    let settled = false;

    // Frames arrive from the device faster than an epoch takes to classify.
    // They are queued rather than dropped, because a dropped frame would leave
    // a hole in the filter's input; the queue is drained in order by a single
    // consumer so two epochs can never be in flight on one processor.
    const queue: BridgeFrame[] = [];
    let draining = false;

    const cleanup = () => {
      if (
        bridge.readyState === bridge.OPEN ||
        bridge.readyState === bridge.CONNECTING
      ) {
        bridge.close();
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const drain = async () => {
      if (draining) return;
      draining = true;

      try {
        while (queue.length) {
          const frame = queue.shift()!;
          if (ws.readyState !== ws.OPEN) return finish();

          const channelNames = frame.channelNames ?? [];
          const { filtered, analysis } = processor.process(
            frame.samples,
            channelNames
          );

          if (!analysis) {
            send(
              buildDataPacket({
                samples: filtered,
                channelNames,
                epochIndex,
                timestamp: frame.timestamp,
              })
            );
            continue;
          }

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
              timestamp: frame.timestamp,
              processed: analysis,
              classification,
            })
          );

          await options.onEpoch?.({
            epochIndex,
            epochTimestamp: frame.timestamp ?? Date.now() / 1000,
            classification,
            features: analysis.features,
            // No trueClass: a live headset has no cue events.
          });
        }
      } catch (error) {
        fail(error);
      } finally {
        draining = false;
      }
    };

    bridge.on('open', () => {
      logger.info(`Hardware bridge connected: ${bridgeUrl}`);
    });

    bridge.on('message', (raw) => {
      let frame: BridgeFrame;

      try {
        frame = JSON.parse(raw.toString());
      } catch {
        logger.warn('Hardware bridge sent a non-JSON frame, ignoring');
        return;
      }

      if (!Array.isArray(frame.samples) || !frame.samples.length) return;

      queue.push(frame);
      void drain();
    });

    bridge.on('error', (error) => {
      fail(new BadRequestError(`Hardware bridge error: ${error.message}`));
    });

    bridge.on('close', () => {
      logger.info(`Hardware bridge closed after ${epochIndex + 1} epochs`);
      clearTimeout(idleTimer);
      finish();
    });

    // Client hangs up -> stop pulling from the device.
    ws.on('close', finish);

    // A bridge that accepts the connection but never sends is worse than one
    // that refuses it, because the user sees an indefinite "connecting" state.
    const idleTimer = setTimeout(() => {
      if (epochIndex < 0 && bridge.readyState !== bridge.OPEN) {
        fail(new BadRequestError('Hardware bridge did not respond'));
      }
    }, streamingConfig.heartbeatMs);
  });
}

export default runHardwareMode;
