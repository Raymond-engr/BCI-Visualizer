import type { ApiEnvelope } from "./types"

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000/api/v1"

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = "ApiError"
  }
}

/**
 * The access token lives in memory, never in localStorage: anything readable by
 * `document.cookie` or `localStorage` is readable by injected script. The
 * refresh token is an httpOnly cookie the server sets, which is what survives a
 * page reload — {@link restoreSession} trades it for a fresh access token.
 *
 * It is module state rather than React state because the WebSocket client and
 * the fetch wrapper both need it outside a component tree.
 */
let accessToken: string | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function getAccessToken(): string | null {
  return accessToken
}

/** Called when refreshing fails, so AuthContext can drop the session. */
let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler
}

/**
 * In-flight refresh, shared by every caller.
 *
 * On a dashboard several requests can 401 in the same tick. Without this, each
 * would POST its own refresh, and since the server rotates the refresh token on
 * every use, the second request would present a token the first had already
 * invalidated and the user would be logged out mid-session.
 */
let refreshInFlight: Promise<string | null> | null = null

async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${API_URL}/auth/refresh-token`, {
        method: "POST",
        credentials: "include",
      })
      if (!response.ok) return null

      const body: ApiEnvelope<{ accessToken: string }> = await response.json()
      accessToken = body.data?.accessToken ?? null
      return accessToken
    } catch {
      return null
    }
  })()

  try {
    return await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const { body, headers, ...rest } = options
  const isFormData = body instanceof FormData

  return fetch(`${API_URL}${path}`, {
    ...rest,
    // Carries the refresh cookie. The server's CORS config sets
    // credentials: true and echoes a specific origin, which is what makes this
    // legal cross-origin.
    credentials: "include",
    headers: {
      // Let the browser set the multipart boundary itself.
      ...(isFormData ? {} : body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: isFormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  })
}

/**
 * Perform a request, refreshing once on a 401, and unwrap the envelope.
 *
 * `retryOnUnauthorized` exists for the refresh call itself: letting it refresh
 * on its own 401 would recurse.
 */
export async function request<T>(
  path: string,
  options: RequestOptions = {},
  retryOnUnauthorized = true
): Promise<T> {
  let response = await send(path, options)

  if (response.status === 401 && retryOnUnauthorized) {
    const refreshed = await refreshAccessToken()
    if (refreshed) {
      response = await send(path, options)
    } else {
      accessToken = null
      onUnauthorized?.()
    }
  }

  // 204, or a body the server chose not to send.
  const text = await response.text()
  if (!text) {
    if (!response.ok) {
      throw new ApiError(response.statusText || "Request failed", response.status)
    }
    return undefined as T
  }

  let body: ApiEnvelope<T>
  try {
    body = JSON.parse(text)
  } catch {
    // A proxy error page or a crash before the JSON handler ran.
    throw new ApiError(
      response.ok ? "Malformed response from server" : text.slice(0, 200),
      response.status
    )
  }

  if (!response.ok || body.success === false) {
    throw new ApiError(body.message || "Request failed", response.status)
  }

  return body.data as T
}

/**
 * Fetch a non-JSON endpoint (the CSV export) with the same auth and refresh
 * handling. Returns the raw Response so the caller can stream or blob it.
 */
export async function requestRaw(
  path: string,
  options: RequestOptions = {}
): Promise<Response> {
  let response = await send(path, options)

  if (response.status === 401) {
    const refreshed = await refreshAccessToken()
    if (refreshed) {
      response = await send(path, options)
    } else {
      accessToken = null
      onUnauthorized?.()
    }
  }

  if (!response.ok) {
    throw new ApiError(response.statusText || "Request failed", response.status)
  }

  return response
}
