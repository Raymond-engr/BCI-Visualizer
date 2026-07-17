import mongoose, { Document, Schema, Types } from 'mongoose';

export enum DatasetFormat {
  GDF = 'gdf',
  CSV = 'csv',
}

export enum DatasetStatus {
  UPLOADED = 'uploaded',
  PARSED = 'parsed',
  INVALID = 'invalid',
}

export interface IDataset extends Document {
  userId: Types.ObjectId;
  originalName: string;
  storedName: string;
  filePath: string;
  format: DatasetFormat;
  sizeBytes: number;
  status: DatasetStatus;
  channelCount?: number;
  channelNames?: string[];
  sampleRate?: number;
  sampleCount?: number;
  durationSeconds?: number;
  eventCount?: number;
  subjectId?: string;
  parseError?: string;
  createdAt: Date;
}

const DatasetSchema: Schema<IDataset> = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    originalName: {
      type: String,
      required: true,
      trim: true,
    },
    storedName: {
      type: String,
      required: true,
    },
    filePath: {
      type: String,
      required: true,
    },
    format: {
      type: String,
      enum: Object.values(DatasetFormat),
      required: true,
    },
    sizeBytes: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(DatasetStatus),
      default: DatasetStatus.UPLOADED,
    },
    channelCount: {
      type: Number,
    },
    channelNames: [
      {
        type: String,
      },
    ],
    sampleRate: {
      type: Number,
    },
    sampleCount: {
      type: Number,
    },
    durationSeconds: {
      type: Number,
    },
    eventCount: {
      type: Number,
    },
    subjectId: {
      type: String,
      trim: true,
      // Selects the subject-specific ONNX model, e.g. "s1" -> csp_lda_s1.onnx
    },
    parseError: {
      type: String,
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
DatasetSchema.index({ userId: 1, createdAt: -1 });
DatasetSchema.index({ userId: 1, status: 1 });

export default mongoose.model<IDataset>('Dataset', DatasetSchema, 'Datasets');
