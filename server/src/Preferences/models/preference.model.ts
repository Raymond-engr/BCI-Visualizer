import mongoose, { Document, Schema, Types } from 'mongoose';
import { SessionMode } from '../../Sessions/models/session.model';

/**
 * Per-user settings.
 *
 * This model deliberately holds only the settings the server actually acts on.
 * The design prototype sketches several more — ICA artifact rejection, reduced
 * motion, high-contrast badges, refresh rate, headset auto-reconnect, impedance
 * warnings, cloud sync. Those are either purely presentational, and so belong
 * in frontend state, or are out of scope for this iteration. Persisting them
 * here would imply the pipeline honours them when it does not, so they are left
 * out until something server-side reads them.
 */
export interface IPreference extends Document {
  userId: Types.ObjectId;
  bandpassLow: number;
  bandpassHigh: number;
  notchEnabled: boolean;
  defaultMode: SessionMode;
  defaultModelId: string;
  createdAt: Date;
  updatedAt: Date;
}

const PreferenceSchema: Schema<IPreference> = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    // Applied by the signal processor at the head of every session. Constrained
    // to bands the coefficient table covers; see preference.controller.
    bandpassLow: {
      type: Number,
      default: 8,
      min: 0.5,
      max: 100,
    },
    bandpassHigh: {
      type: Number,
      default: 30,
      min: 1,
      max: 125,
    },
    // Mirrors the notch toggle on the dashboard, and seeds its initial state.
    notchEnabled: {
      type: Boolean,
      default: true,
    },
    // Preselects the source card on the session setup screen.
    defaultMode: {
      type: String,
      enum: Object.values(SessionMode),
      default: SessionMode.SIMULATION,
    },
    // Which exported model new sessions classify against.
    defaultModelId: {
      type: String,
      default: 'global',
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false, // Using custom createdAt/updatedAt fields
  }
);

export default mongoose.model<IPreference>(
  'Preference',
  PreferenceSchema,
  'Preferences'
);
