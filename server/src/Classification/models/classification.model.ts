import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * The Motor Imagery classes this system discriminates.
 *
 * BCI Competition IV Dataset 2a records four tasks, but tongue imagery is
 * deliberately excluded here: its scalp signature is centro-frontal and
 * overlaps heavily with jaw EMG, so it is both the weakest of the four in the
 * literature and the one least suited to the C3/Cz/C4 sensorimotor montage this
 * pipeline is built around. Dropping it leaves a three-class problem with a
 * clean lateralised structure (left / right / bilateral-central) and lifts
 * chance level from 25% to 33.3%.
 */
export enum MILabel {
  LEFT_HAND = 'left_hand',
  RIGHT_HAND = 'right_hand',
  FEET = 'feet',
  UNKNOWN = 'unknown',
}

export interface IClassification extends Document {
  sessionId: Types.ObjectId;
  epochIndex: number;
  epochTimestamp: number;
  predictedClass: MILabel;
  confidence: number;
  allScores: Map<string, number>;
  features: number[];
  inferenceMs?: number;
  trueClass?: MILabel;
  createdAt: Date;
}

const ClassificationSchema: Schema<IClassification> = new Schema(
  {
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: 'Session',
      required: true,
      index: true,
    },
    epochIndex: {
      type: Number,
      required: true,
    },
    epochTimestamp: {
      type: Number,
      required: true,
    },
    predictedClass: {
      type: String,
      enum: Object.values(MILabel),
      required: true,
    },
    confidence: {
      type: Number,
      min: 0,
      max: 1,
    },
    allScores: {
      type: Map,
      of: Number,
    },
    features: [
      {
        type: Number,
      },
    ],
    inferenceMs: {
      type: Number,
    },
    trueClass: {
      type: String,
      enum: Object.values(MILabel),
      // Populated only when the recording carries cue events, which is what
      // makes per-session accuracy computable.
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
ClassificationSchema.index({ sessionId: 1, epochIndex: 1 });
ClassificationSchema.index({ sessionId: 1, predictedClass: 1 });

export default mongoose.model<IClassification>(
  'Classification',
  ClassificationSchema,
  'Classifications'
);
