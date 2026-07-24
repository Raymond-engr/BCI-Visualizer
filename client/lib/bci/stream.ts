import type { SessionMode } from "@/lib/api/types"
import type { MiClass } from "./constants"

/**
 * The WebSocket protocol, mirroring server/src/Streaming/services/packet.service.ts.
 * Kept as plain types rather than re-exported from the server so the client has
 * no build-time dependency on it.
 */

export type StatusCode = "STARTED" | "COMPLETED" | "ERROR" | "APPLIED"

export interface FilterSettings {
  bandpassLow: number
  bandpassHigh: number
  notch: boolean
}

/** Sent once with STARTED so the client never hardcodes the montage. */
export interface StreamConfig {
  mode: string
  sampleRate: number
  channelNames: string[]
  packetSamples: number
  epochSamples: number
  stepSamples: number
  /** Playback rate relative to real time. Upload replays at 8x by default. */
  speed: number
  labels: string[]
  filters: FilterSettings
  /** False for hardware, which has no cue events, so accuracy is never available. */
  hasGroundTruth: boolean
}

/**
 * `samples` arrives on every packet at 25 Hz. The analysis fields only appear
 * on the packet that closes an epoch — roughly 1 in 25 — and are absent from
 * the rest, so consumers must keep the last value they saw.
 */
export interface DataPacket {
  type: "DATA_PACKET"
  /** Stream time, not wall time. Upload mode replays faster than real time. */
  timestamp: number
  /** [channel][sample], already bandpassed and optionally notched. */
  samples: number[][]
  channelNames: string[]
  psd?: { freqs: number[]; power: number[] }
  topographic?: Record<string, number>
  classification?: {
    predictedClass: MiClass
    confidence: number
    allScores: Record<string, number>
  }
  /** Index of the most recent completed epoch, or -1 before the first. */
  epochIndex: number
}

export interface StatusMessage {
  type: "STATUS"
  status: StatusCode
  message: string
  sessionId?: string
  config?: StreamConfig
  /** Echoed after a CONTROL frame, whether it was applied or rejected. */
  filters?: FilterSettings
}

export type ServerMessage = DataPacket | StatusMessage

/** A socket carries no Authorization header, so the token rides in INIT. */
export interface InitFrame {
  type: "INIT"
  token: string
  sessionId: string
  mode: SessionMode
  datasetId?: string
  hardwareWsUrl?: string
  modelId?: string
  notch?: boolean
  bandpassLow?: number
  bandpassHigh?: number
}

/** Retunes a running stream. Reopening the socket would restart the recording. */
export interface ControlFrame {
  type: "CONTROL"
  notch?: boolean
  bandpassLow?: number
  bandpassHigh?: number
}

export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:5000/ws/stream"
