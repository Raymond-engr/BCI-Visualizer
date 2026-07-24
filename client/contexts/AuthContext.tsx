"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import * as authApi from "@/lib/api/auth"
import { setAccessToken, setUnauthorizedHandler } from "@/lib/api/client"
import type { AuthUser } from "@/lib/api/types"

export type AuthStatus = "loading" | "authenticated" | "unauthenticated"

interface AuthState {
  user: AuthUser | null
  status: AuthStatus
  login: (email: string, password: string) => Promise<void>
  register: (input: authApi.RegisterInput) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [status, setStatus] = useState<AuthStatus>("loading")

  /**
   * Rehydrate on first mount.
   *
   * The access token is deliberately memory-only, so a reload always starts
   * with nothing. The refresh cookie is httpOnly and survives, so trading it
   * for a fresh access token is the only way back into an existing session.
   * Failure here is the normal signed-out path, not an error worth surfacing.
   */
  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const { accessToken } = await authApi.refreshToken()
        setAccessToken(accessToken)

        const { user: verified } = await authApi.verifyToken()
        if (cancelled) return

        setUser({ id: verified._id, email: verified.email, role: verified.role })
        setStatus("authenticated")
      } catch {
        if (cancelled) return
        setAccessToken(null)
        setUser(null)
        setStatus("unauthenticated")
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  // The fetch wrapper reaches this when a refresh fails mid-session — an
  // expired or revoked refresh token — which React state can't observe itself.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null)
      setStatus("unauthenticated")
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const payload = await authApi.login(email, password)
    setAccessToken(payload.accessToken)
    setUser(payload.user)
    setStatus("authenticated")
  }, [])

  const register = useCallback(async (input: authApi.RegisterInput) => {
    const payload = await authApi.register(input)
    setAccessToken(payload.accessToken)
    setUser(payload.user)
    setStatus("authenticated")
  }, [])

  const logout = useCallback(async () => {
    try {
      await authApi.logout()
    } catch {
      // The cookie may already be expired or revoked. Either way the local
      // session is over, so a failure here must not strand the user signed in.
    } finally {
      setAccessToken(null)
      setUser(null)
      setStatus("unauthenticated")
    }
  }, [])

  const value = useMemo<AuthState>(
    () => ({ user, status, login, register, logout }),
    [user, status, login, register, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return ctx
}
