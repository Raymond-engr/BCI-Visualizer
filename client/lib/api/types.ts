import type { MiClass, SessionSource } from "@/lib/bci/constants"

/** Every REST response the server sends is wrapped in this envelope. */
export interface ApiEnvelope<T> {
  success: boolean
  message: string
  data?: T
}

export interface User {
  id: string
  name: string
  email: string
  role: string
  institution?: string
}

export interface AuthPayload {
  accessToken: string
  user: User
}

/**
 * `/auth/verify-token` echoes back the JWT payload rather than the user
 * document, so its shape differs from the one login returns.
 */
export interface VerifiedUser {
  _id: string
  email?: string
  role: string
}

/**
 * The identity AuthContext exposes.
 *
 * `name` and `institution` are optional because the two ways a session starts
 * yield different amounts of information: logging in returns the full user
 * document, whereas rehydrating after a reload goes through
 * `/auth/verify-token`, which only echoes the JWT payload. Nothing in the UI
 * renders the name, so this is not worth a second round trip.
 */
export interface AuthUser {
  id: string
  email?: string
  role: string
  name?: string
  institution?: string
}

/** The server's canonical mode names. The UI's own names are {@link SessionSource}. */
export type SessionMode = "upload" | "simulation" | "hardware"
export type SessionStatus = "pending" | "active" | "completed" | "error"

const MODE_BY_SOURCE: Record<SessionSource, SessionMode> = {
  upload: "upload",
  sim: "simulation",
  hw: "hardware",
}

const SOURCE_BY_MODE: Record<SessionMode, SessionSource> = {
  upload: "upload",
  simulation: "sim",
  hardware: "hw",
}

/** Translate the UI's source name into the mode the API persists. */
export function toSessionMode(source: SessionSource): SessionMode {
  return MODE_BY_SOURCE[source]
}

export function toSessionSource(mode: SessionMode): SessionSource {
  return SOURCE_BY_MODE[mode]
}

export type DatasetFormat = "gdf" | "csv"
export type DatasetStatus = "uploaded" | "parsed" | "invalid"

export interface Dataset {
  _id: string
  userId: string
  originalName: string
  storedName: string
  format: DatasetFormat
  sizeBytes: number
  status: DatasetStatus
  channelCount?: number
  channelNames?: string[]
  sampleRate?: number
  sampleCount?: number
  durationSeconds?: number
  eventCount?: number
  subjectId?: string
  parseError?: string
  createdAt: string
}

export interface Session {
  _id: string
  userId: string
  /** Populated to a Dataset on list/getById; absent for simulation and hardware. */
  datasetId?: string | Dataset
  mode: SessionMode
  status: SessionStatus
  modelId: string
  epochCount: number
  /** Null for hardware, which has no cue events to score against. */
  accuracy?: number | null
  classDistribution?: Record<string, number>
  meanConfidence?: number
  meanInferenceMs?: number
  errorMessage?: string
  startTime: string
  endTime?: string
  durationSeconds?: number
  createdAt: string
  /** Virtuals — the server derives these so clients don't rebranch on mode. */
  sourceLabel: string
  hasGroundTruth: boolean
}

export interface Pagination {
  page: number
  limit: number
  total: number
  pages: number
}

export interface SessionListPayload {
  sessions: Session[]
  pagination: Pagination
}

/** One row of the `$group` the server runs over a session's epochs. */
export interface BreakdownRow {
  _id: MiClass
  count: number
  meanConfidence?: number
}

export interface SessionDetailPayload {
  session: Session
  breakdown: BreakdownRow[]
}

export interface SessionSummary {
  sessionId: string
  mode: SessionMode
  status: SessionStatus
  startTime: string
  endTime?: string
  durationSeconds?: number
  epochs: number
  meanConfidence: number | null
  meanInferenceMs: number | null
  accuracy: number | null
  labelledEpochs: number
  breakdown: BreakdownRow[]
}

export interface Classification {
  _id: string
  sessionId: string
  epochIndex: number
  epochTimestamp: number
  predictedClass: MiClass
  confidence: number
  allScores: Record<MiClass, number>
  inferenceMs: number
  trueClass?: MiClass
}

/**
 * Only the four settings the pipeline actually acts on are stored server-side.
 * The prototype's other toggles are presentational and stay in frontend state.
 */
export interface Preferences {
  _id: string
  userId: string
  bandpassLow: number
  bandpassHigh: number
  notchEnabled: boolean
  defaultMode: SessionMode
  defaultModelId: string
  updatedAt?: string
}

export interface PreferencesUpdate {
  bandpassLow?: number
  bandpassHigh?: number
  notchEnabled?: boolean
  defaultMode?: SessionMode
  defaultModelId?: string
}

export interface BandpassOption {
  low: number
  high: number
  label: string
}

export interface PreferenceOptions {
  sampleRate: number
  /** Fixed by the pipeline; reported so the UI doesn't hardcode it. */
  epochSeconds: number
  notchFreq: number
  bandpassOptions: BandpassOption[]
}
