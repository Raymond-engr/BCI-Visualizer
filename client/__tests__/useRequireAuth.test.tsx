import { renderHook, waitFor } from "@testing-library/react"

import { useRequireAuth } from "@/hooks/useRequireAuth"
import type { AuthStatus } from "@/contexts/AuthContext"

const replace = jest.fn()

// One stable object, as the real useRouter returns. The hook's effect keys on
// the router identity, so a fresh object per render would re-run the redirect
// effect here in a way it never does in the app.
const router = { replace, push: jest.fn() }

jest.mock("next/navigation", () => ({
  useRouter: () => router,
}))

let status: AuthStatus = "loading"

jest.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: null, status, login: jest.fn(), register: jest.fn(), logout: jest.fn() }),
}))

beforeEach(() => {
  jest.clearAllMocks()
  status = "loading"
})

describe("while auth is rehydrating", () => {
  it("reports loading rather than guessing", async () => {
    // The guard lives on the client because the access token is memory-only and
    // the refresh cookie belongs to the API's origin — the Next server can see
    // neither at render time, so there is nothing for proxy.ts to check.
    status = "loading"

    const { result } = renderHook(() => useRequireAuth())

    expect(result.current).toBe("loading")
  })

  it("does not redirect during the rehydration window", async () => {
    // Rehydration costs a round trip. Treating that window as signed out would
    // bounce the user off the dashboard on every single refresh.
    status = "loading"

    renderHook(() => useRequireAuth())

    await new Promise((r) => setTimeout(r, 20))
    expect(replace).not.toHaveBeenCalled()
  })

  it("still holds off after a re-render while loading", async () => {
    // A parent re-rendering mid-rehydration must not be what decides the user
    // is signed out.
    status = "loading"

    const { rerender } = renderHook(() => useRequireAuth())
    rerender()
    rerender()

    expect(replace).not.toHaveBeenCalled()
  })
})

describe("once auth has settled", () => {
  it("sends a signed-out visitor to sign-in", async () => {
    status = "unauthenticated"

    const { result } = renderHook(() => useRequireAuth())

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in"))
    expect(result.current).toBe("unauthenticated")
  })

  it("redirects only after loading has genuinely resolved to signed out", async () => {
    // The realistic sequence: the hook mounts mid-rehydration and the refresh
    // then fails. The redirect belongs to the second state, not the first.
    status = "loading"
    const { rerender } = renderHook(() => useRequireAuth())
    expect(replace).not.toHaveBeenCalled()

    status = "unauthenticated"
    rerender()

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in"))
  })

  it("leaves a signed-in user where they are", async () => {
    status = "authenticated"

    const { result } = renderHook(() => useRequireAuth())

    await new Promise((r) => setTimeout(r, 20))
    expect(replace).not.toHaveBeenCalled()
    expect(result.current).toBe("authenticated")
  })

  it("never redirects a reload that rehydrates successfully", async () => {
    // The whole point of the loading state: this is the common path, and the
    // user must not see the sign-in page flash on the way through it.
    status = "loading"
    const { rerender, result } = renderHook(() => useRequireAuth())

    status = "authenticated"
    rerender()

    await new Promise((r) => setTimeout(r, 20))
    expect(replace).not.toHaveBeenCalled()
    expect(result.current).toBe("authenticated")
  })

  it("redirects once, not on every re-render", async () => {
    // The effect keys on status, so a busy parent must not queue a redirect per
    // render pass.
    status = "unauthenticated"

    const { rerender } = renderHook(() => useRequireAuth())
    await waitFor(() => expect(replace).toHaveBeenCalled())

    rerender()
    rerender()

    expect(replace).toHaveBeenCalledTimes(1)
  })
})

describe("a session that expires mid-visit", () => {
  it("ejects the user when the token stops being accepted", async () => {
    // The fetch wrapper flips the context to unauthenticated when a refresh
    // fails, and the guard is what turns that into a redirect.
    status = "authenticated"
    const { rerender } = renderHook(() => useRequireAuth())
    expect(replace).not.toHaveBeenCalled()

    status = "unauthenticated"
    rerender()

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in"))
  })
})
