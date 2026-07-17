import mongoose, { Document, Schema, Types } from 'mongoose';

export enum SessionMode {
  UPLOAD = 'upload',
  SIMULATION = 'simulation',
  HARDWARE = 'hardware',
}

export enum SessionStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  ERROR = 'error',
}

export interface ISession extends Document {
  userId: Types.ObjectId;
  datasetId?: Types.ObjectId;
  mode: SessionMode;
  status: SessionStatus;
  modelId: string;
  epochCount: number;
  accuracy?: number;
  classDistribution?: Map<string, number>;
  meanConfidence?: number;
  meanInferenceMs?: number;
  errorMessage?: string;
  startTime: Date;
  endTime?: Date;
  durationSeconds?: number;
  createdAt: Date;
}

const SessionSchema: Schema<ISession> = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    datasetId: {
      type: Schema.Types.ObjectId,
      ref: 'Dataset',
      // Absent for simulation and hardware sessions.
    },
    mode: {
      type: String,
      enum: Object.values(SessionMode),
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(SessionStatus),
      default: SessionStatus.PENDING,
    },
    modelId: {
      type: String,
      default: 'global',
    },
    epochCount: {
      type: Number,
      default: 0,
    },
    accuracy: {
      type: Number,
      min: 0,
      max: 1,
      // Only computable when the recording carries cue events.
    },
    classDistribution: {
      type: Map,
      of: Number,
    },
    meanConfidence: {
      type: Number,
      min: 0,
      max: 1,
    },
    meanInferenceMs: {
      type: Number,
    },
    errorMessage: {
      type: String,
    },
    startTime: {
      type: Date,
      default: Date.now,
    },
    endTime: {
      type: Date,
    },
    durationSeconds: {
      type: Number,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false, // Using custom createdAt field
  }
);

// Indexes for performance optimization
SessionSchema.index({ userId: 1, createdAt: -1 });
SessionSchema.index({ userId: 1, status: 1 });

/**
 * The label the session history renders as its title.
 *
 * Only upload sessions have a dataset to name. Simulation and hardware
 * sessions have no datasetId at all, so without this every client would have to
 * reimplement the same mode-to-label branch. Deriving it once here keeps the
 * naming consistent across the history list, the export filename and any future
 * consumer.
 */
SessionSchema.virtual('sourceLabel').get(function (this: ISession) {
  if (this.mode === SessionMode.SIMULATION) return 'Live Simulation';
  if (this.mode === SessionMode.HARDWARE) return 'Hardware Stream';

  const dataset = this.datasetId as unknown as { originalName?: string } | null;
  return dataset?.originalName ?? 'Uploaded Dataset';
});

/**
 * Whether an accuracy figure is meaningful for this session.
 *
 * Hardware sessions never have one: a live headset emits no cue events, so
 * there is no ground truth to score against. The client needs to distinguish
 * "not measured yet" from "cannot be measured" to know whether to render a
 * dash or a spinner.
 */
SessionSchema.virtual('hasGroundTruth').get(function (this: ISession) {
  return this.mode !== SessionMode.HARDWARE;
});

SessionSchema.set('toJSON', { virtuals: true });
SessionSchema.set('toObject', { virtuals: true });

export default mongoose.model<ISession>('Session', SessionSchema, 'Sessions');
