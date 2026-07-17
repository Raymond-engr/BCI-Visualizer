import { WebSocketServer, WebSocket, RawData } from 'ws';
import { SignalProcessor } from '../../Signal_Processing/services/signalProcessor.service';
import {
  getClassifier,
  Classifier,
} from '../../Classification/services/mlServiceClient.service';
import Classification from '../../Classification/models/classification.model';
import Session, {
  SessionMode,
  SessionStatus,
} from '../../Sessions/models/session.model';
import { runSimulationMode } from '../modes/simulation.mode';
import { runUploadMode, UPLOAD_SPEED } from '../modes/upload.mode';
import { runHardwareMode } from '../modes/hardware.mode';
import { authenticateSocketToken } from '../../middleware/auth.middleware';
import { channelOrder } from '../../utils/montage';
import { buildStatus, OutboundMessage, StreamConfig } from './packet.service';
import { streamingConfig, classifierConfig } from '../../config/streaming';
import { BadRequestError } from '../../utils/customErrors';
import logger from '../../utils/logger';
import type { EpochSink } from '../modes/upload.mode';

interface InitMessage {
  type: 'INIT';
  token: string;
  sessionId: string;
  mode: SessionMode;
  datasetId?: string;
  hardwareWsUrl?: string;
  modelId?: string;
  notch?: boolean;
  bandpassLow?: number;
  bandpassHigh?: number;
}

/**
 * Sent by the client to change filter settings without restarting the stream.
 *
 * The dashboard exposes the bandpass cutoffs and the notch toggle as live
 * controls, so these have to take effect on a running session; tearing the
 * socket down and re-running from the start of the recording to change one
 * toggle would lose the session's history and be visibly wrong.
 */
interface ControlMessage {
  type: 'CONTROL';
  notch?: boolean;
  bandpassLow?: number;
  bandpassHigh?: number;
}

/** WebSocket close codes used by this server. */
const CLOSE = {
  UNSUPPORTED_DATA: 1003,
  POLICY_VIOLATION: 1008,
  INTERNAL_ERROR: 1011,
} as const;

/**
 * Routes WebSocket connections into the streaming pipeline.
 *
 * One instance is created at boot and attached to the shared HTTP server, so
 * REST and WebSocket traffic run on one port. Per-connection state — signal
 * processor, epoch counter, buffered writes — is created inside the connection
 * handler and never hoisted onto the class, because a field here would be
 * shared by every concurrent client.
 */
export class SessionManager {
  private readonly classifier: Classifier;
  private readonly liveSockets = new Set<WebSocket>();

  constructor(private wss: WebSocketServer) {
    this.classifier = getClassifier();

    // Preload the default model so the first epoch of the first session is not
    // penalised by graph construction.
    this.classifier.load().catch((error) => {
      logger.error(`[Stream] Classifier preload failed: ${error.message}`);
    });

    this.wss.on('connection', this.onConnect.bind(this));
    this.startHeartbeat();
  }

  /** Sockets currently attached. */
  get connectionCount(): number {
    return this.liveSockets.size;
  }

  private onConnect(ws: WebSocket) {
    this.liveSockets.add(ws);
    ws.on('close', () => this.liveSockets.delete(ws));
    ws.on('pong', () => ((ws as any).isAlive = true));
    (ws as any).isAlive = true;

    const send = (data: OutboundMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
    };

    // The processor is created inside runSession but has to be reachable from
    // the message handler so CONTROL frames can retune a running stream.
    let processor: SignalProcessor | null = null;
    let initialised = false;

    ws.on('message', async (raw: RawData) => {
      let msg: InitMessage | ControlMessage;

      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return ws.close(CLOSE.UNSUPPORTED_DATA, 'Invalid message');
      }

      // Everything after the first frame is a control change, not a new
      // session; a second INIT on the same socket is a client bug.
      if (initialised) {
        if (msg.type !== 'CONTROL') {
          return send(
            buildStatus('ERROR', `Expected CONTROL, received "${msg.type}"`)
          );
        }
        return this.applyControl(processor, msg, send);
      }

      if (msg.type !== 'INIT') {
        return ws.close(CLOSE.UNSUPPORTED_DATA, 'Expected INIT');
      }

      initialised = true;

      try {
        await this.runSession(ws, send, msg, (p) => (processor = p));
      } catch (error: any) {
        logger.error(`[Stream] Session failed: ${error.message}`);
        send(buildStatus('ERROR', error.message, msg.sessionId));

        await Session.findByIdAndUpdate(msg.sessionId, {
          status: SessionStatus.ERROR,
          errorMessage: error.message,
          endTime: new Date(),
        }).catch(() => undefined);

        ws.close(CLOSE.INTERNAL_ERROR, 'Session error');
      }
    });
  }

  /**
   * Apply a CONTROL frame to the running processor.
   *
   * A rejected change — an unsupported band, say — is reported back on the
   * socket rather than thrown, because it is a user action on a healthy stream
   * and must not tear the session down.
   */
  private applyControl(
    processor: SignalProcessor | null,
    msg: ControlMessage,
    send: (data: OutboundMessage) => void
  ): void {
    if (!processor) {
      return send(buildStatus('ERROR', 'Session is not running yet'));
    }

    try {
      if (msg.bandpassLow !== undefined && msg.bandpassHigh !== undefined) {
        processor.setBandpass(msg.bandpassLow, msg.bandpassHigh);
      }
      if (msg.notch !== undefined) {
        processor.setNotch(msg.notch);
      }

      send(
        buildStatus('APPLIED', 'Filter settings updated', undefined, {
          filters: processor.settings,
        })
      );
    } catch (error: any) {
      // The processor rejects before mutating, so the stream continues on the
      // previous settings and the client can show the old values as still live.
      send(
        buildStatus('ERROR', error.message, undefined, {
          filters: processor.settings,
        })
      );
    }
  }

  private async runSession(
    ws: WebSocket,
    send: (data: OutboundMessage) => void,
    msg: InitMessage,
    onProcessor: (processor: SignalProcessor) => void
  ) {
    // A socket carries no Authorization header, so the token rides in INIT.
    const user = await authenticateSocketToken(msg.token);

    const session = await Session.findById(msg.sessionId);
    if (!session) {
      throw new BadRequestError('Unknown sessionId');
    }
    if (String(session.userId) !== String(user._id)) {
      ws.close(CLOSE.POLICY_VIOLATION, 'Session belongs to another user');
      throw new BadRequestError('Session belongs to another user');
    }
    if (session.status !== SessionStatus.PENDING) {
      throw new BadRequestError(
        `Session is already ${session.status} and cannot be restarted`
      );
    }

    const modelId = msg.modelId || session.modelId;
    const processor = new SignalProcessor({
      modelId,
      notch: msg.notch,
      bandpassLow: msg.bandpassLow,
      bandpassHigh: msg.bandpassHigh,
    });
    onProcessor(processor);

    session.status = SessionStatus.ACTIVE;
    session.startTime = new Date();
    await session.save();

    // The client should not have to hardcode the montage, the sample rate or
    // the class list to lay out the dashboard, so the stream describes itself
    // once up front.
    const config: StreamConfig = {
      mode: msg.mode,
      sampleRate: streamingConfig.sampleRate,
      channelNames: channelOrder,
      packetSamples: streamingConfig.packetSamples,
      epochSamples: streamingConfig.epochSamples,
      stepSamples: streamingConfig.stepSamples,
      speed: msg.mode === SessionMode.UPLOAD ? UPLOAD_SPEED : 1,
      labels: [...classifierConfig.labels],
      filters: processor.settings,
      // A live headset has no cue events, so no accuracy can ever be computed
      // for it. Saying so up front lets the client render a dash instead of
      // waiting for a number that will never arrive.
      hasGroundTruth: msg.mode !== SessionMode.HARDWARE,
    };

    send(
      buildStatus('STARTED', 'Session started', String(session._id), { config })
    );
    logger.info(
      `[Stream] Session ${session._id} started in ${msg.mode} mode for ${user.email}`
    );

    // Epochs are buffered and flushed in batches. A four-minute session emits
    // ~240 epochs; one insert each would put a round trip to Mongo inside the
    // per-epoch budget for no benefit, since nothing reads them until the
    // session ends.
    const { sink, flush, stats } = this.createEpochSink(String(session._id));

    try {
      switch (msg.mode) {
        case SessionMode.SIMULATION:
          await runSimulationMode(ws, processor, this.classifier, send, {
            modelId,
            onEpoch: sink,
          });
          break;

        case SessionMode.UPLOAD:
          if (!msg.datasetId) {
            throw new BadRequestError('Upload sessions require a datasetId');
          }
          await runUploadMode(
            ws,
            processor,
            this.classifier,
            send,
            msg.datasetId,
            String(user._id),
            { modelId, onEpoch: sink }
          );
          break;

        case SessionMode.HARDWARE:
          if (!msg.hardwareWsUrl) {
            throw new BadRequestError(
              'Hardware sessions require a hardwareWsUrl'
            );
          }
          await runHardwareMode(
            ws,
            processor,
            this.classifier,
            send,
            msg.hardwareWsUrl,
            { modelId, onEpoch: sink }
          );
          break;

        default:
          throw new BadRequestError(`Unknown session mode "${msg.mode}"`);
      }

      await flush();
      await this.finaliseSession(session, stats);

      send(buildStatus('COMPLETED', 'Session complete', String(session._id)));
      logger.info(
        `[Stream] Session ${session._id} completed with ${stats.count} epochs`
      );
    } finally {
      // Whether the run succeeded or threw, epochs already classified are worth
      // keeping — an interrupted session should still show its partial history.
      await flush().catch((error) =>
        logger.error(`[Stream] Final flush failed: ${error.message}`)
      );
      processor.reset();
    }
  }

  /**
   * Build the per-epoch persistence hook, its flush function, and a running
   * tally used to finalise the session.
   */
  private createEpochSink(sessionId: string) {
    const BATCH = 25;
    let pending: any[] = [];

    const stats = {
      count: 0,
      confidenceSum: 0,
      inferenceSum: 0,
      correct: 0,
      labelled: 0,
      distribution: {} as Record<string, number>,
    };

    const flush = async () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      await Classification.insertMany(batch, { ordered: false });
    };

    const sink: EpochSink = async (epoch) => {
      stats.count++;
      stats.confidenceSum += epoch.classification.confidence;
      stats.inferenceSum += epoch.classification.inferenceMs;
      stats.distribution[epoch.classification.predictedClass] =
        (stats.distribution[epoch.classification.predictedClass] ?? 0) + 1;

      if (epoch.trueClass) {
        stats.labelled++;
        if (epoch.trueClass === epoch.classification.predictedClass) {
          stats.correct++;
        }
      }

      pending.push({
        sessionId,
        epochIndex: epoch.epochIndex,
        epochTimestamp: epoch.epochTimestamp,
        predictedClass: epoch.classification.predictedClass,
        confidence: epoch.classification.confidence,
        allScores: epoch.classification.allScores,
        features: epoch.features,
        inferenceMs: epoch.classification.inferenceMs,
        trueClass: epoch.trueClass,
      });

      if (pending.length >= BATCH) await flush();
    };

    return { sink, flush, stats };
  }

  private async finaliseSession(
    session: any,
    stats: ReturnType<SessionManager['createEpochSink']>['stats']
  ) {
    const endTime = new Date();

    session.status = SessionStatus.COMPLETED;
    session.endTime = endTime;
    session.durationSeconds =
      (endTime.getTime() - session.startTime.getTime()) / 1000;
    session.epochCount = stats.count;
    session.classDistribution = stats.distribution;

    if (stats.count) {
      session.meanConfidence = stats.confidenceSum / stats.count;
      session.meanInferenceMs = stats.inferenceSum / stats.count;
    }
    if (stats.labelled) {
      session.accuracy = stats.correct / stats.labelled;
    }

    await session.save();
  }

  /**
   * Drop sockets that stopped responding.
   *
   * A browser tab closed by killing the process never sends a close frame, so
   * without this the server would hold the socket — and its interval timer and
   * signal processor — open indefinitely.
   */
  private startHeartbeat() {
    const timer = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if ((ws as any).isAlive === false) return ws.terminate();
        (ws as any).isAlive = false;
        ws.ping();
      });
    }, streamingConfig.heartbeatMs);

    this.wss.on('close', () => clearInterval(timer));
  }

  /** Close every socket. Used on graceful shutdown. */
  shutdown(): void {
    this.liveSockets.forEach((ws) => ws.close(1001, 'Server shutting down'));
    this.liveSockets.clear();
  }
}

export default SessionManager;
