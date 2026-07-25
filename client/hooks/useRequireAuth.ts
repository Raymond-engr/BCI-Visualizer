"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

import { useAuth, type AuthStatus } from "@/contexts/AuthContext"

/**
 * Redirect to sign-in unless the user is authenticated.
 *
 * Guarding here rather than in `proxy.ts` is deliberate: the access token lives
 * in memory and the refresh cookie is set by the API on its own origin, so the
 * Next server has nothing it could usefully check. Callers must handle the
 * "loading" status themselves — rehydration takes a round trip, and treating it
 * as signed-out would bounce every reload to the sign-in page.
 */
export function useRequireAuth(): AuthStatus {
  const { status } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/sign-in")
    }
  }, [status, router])

  return status
}
