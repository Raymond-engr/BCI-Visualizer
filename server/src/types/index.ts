import type { Request } from 'express';
import type { IUser } from '../model/user.model';

/** An Express request that has passed through authenticateToken. */
export interface AuthenticatedRequest extends Request {
  user: IUser;
}

/** A recording after parsing, before montage alignment. */
export interface ParsedRecording {
  samples: number[][]; // [channel][sample]
  channelNames: string[];
  sampleRate: number;
  events: RecordingEvent[];
  metadata: RecordingMetadata;
}

export interface RecordingEvent {
  position: number; // Sample index
  typeCode: number; // GDF event code
  duration: number; // Samples
}

export interface RecordingMetadata {
  subjectId?: string;
  recordingDate?: Date;
  channelCount: number;
  sampleCount: number;
  durationSeconds: number;
}

export { MILabel } from '../Classification/models/classification.model';
export { SessionMode, SessionStatus } from '../Sessions/models/session.model';
export { DatasetFormat, DatasetStatus } from '../Datasets/models/dataset.model';
export type {
  DataPacket,
  StatusMessage,
  OutboundMessage,
  StatusCode,
} from '../Streaming/services/packet.service';
export type { ClassificationResult } from '../Classification/services/onnxClassifier.service';
