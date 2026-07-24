import { request } from "./client"
import type { AuthPayload, VerifiedUser } from "./types"

export interface RegisterInput {
  name: string
  email: string
  password: string
  institution?: string
}

export function login(email: string, password: string): Promise<AuthPayload> {
  return request<AuthPayload>("/auth/login", {
    method: "POST",
    body: { email, password },
  })
}

export function register(input: RegisterInput): Promise<AuthPayload> {
  return request<AuthPayload>("/auth/register", {
    method: "POST",
    body: input,
  })
}

/**
 * Trade the httpOnly refresh cookie for a new access token. Used on page load
 * to rehydrate a session, since the access token itself is memory-only.
 */
export function refreshToken(): Promise<{ accessToken: string }> {
  return request<{ accessToken: string }>(
    "/auth/refresh-token",
    { method: "POST" },
    false
  )
}

export function logout(): Promise<void> {
  return request<void>("/auth/logout", { method: "POST" })
}

/** Echoes the JWT payload — `_id`, `email`, `role`. Not the full user document. */
export function verifyToken(): Promise<{ user: VerifiedUser }> {
  return request<{ user: VerifiedUser }>("/auth/verify-token")
}
