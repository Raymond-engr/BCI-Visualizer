import { request, requestRaw } from "./client"
import type {
  Classification,
  Session,
  SessionDetailPayload,
  SessionListPayload,
  SessionMode,
  SessionSummary,
} from "./types"

export interface CreateSessionInput {
  mode: SessionMode
  /** Required for upload mode. */
  datasetId?: string
  modelId?: string
}

/**
 * Reserve the session over REST before opening the socket. An aborted socket
 * then still leaves a record the user can see rather than a silent no-op.
 */
export function createSession(input: CreateSessionInput): Promise<Session> {
  return request<Session>("/sessions", { method: "POST", body: input })
}

export function listSessions(params?: {
  page?: number
  limit?: number
  mode?: SessionMode
  status?: string
}): Promise<SessionListPayload> {
  const query = new URLSearchParams()
  if (params?.page) query.set("page", String(params.page))
  if (params?.limit) query.set("limit", String(params.limit))
  if (params?.mode) query.set("mode", params.mode)
  if (params?.status) query.set("status", params.status)

  const suffix = query.toString() ? `?${query}` : ""
  return request<SessionListPayload>(`/sessions${suffix}`)
}

export function getSession(sessionId: string): Promise<SessionDetailPayload> {
  return request<SessionDetailPayload>(`/sessions/${sessionId}`)
}

export function getClassifications(sessionId: string): Promise<Classification[]> {
  return request<Classification[]>(`/sessions/${sessionId}/classifications`)
}

export function deleteSession(sessionId: string): Promise<void> {
  return request<void>(`/sessions/${sessionId}`, { method: "DELETE" })
}

export function getSummary(sessionId: string): Promise<SessionSummary> {
  return request<SessionSummary>(`/results/${sessionId}/summary`)
}

/**
 * Download a session's epoch log as CSV.
 *
 * The endpoint streams and sets Content-Disposition, but it also needs a Bearer
 * header, so a plain anchor href would 401. Fetching to a blob keeps the auth
 * path identical to every other call.
 */
export async function exportSessionCSV(
  sessionId: string,
  fallbackName: string
): Promise<void> {
  const response = await requestRaw(`/results/${sessionId}/export`)
  const blob = await response.blob()

  const disposition = response.headers.get("Content-Disposition") ?? ""
  const match = disposition.match(/filename="?([^"]+)"?/)
  const filename = match?.[1] ?? fallbackName

  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
