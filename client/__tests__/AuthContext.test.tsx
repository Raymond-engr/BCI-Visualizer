import type { ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"

import { AuthProvider, useAuth } from "@/contexts/AuthContext"
import * as authApi from "@/lib/api/auth"
import {
  getAccessToken,
  request,
  setAccessToken,
  setUnauthorizedHandler,
} from "@/lib/api/client"

jest.mock("@/lib/api/auth")

const mocked = authApi as jest.Mocked<typeof authApi>

const wrapper = ({ children }: { children: ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
)

const USER = {
  id: "u1",
  name: "Ada Lovelace",
  email: "ada@uniben.edu",
  role: "researcher",
}

beforeEach(() => {
  jest.resetAllMocks()
  setAccessToken(null)
  setUnauthorizedHandler(null)
})

describe("rehydration on load", () => {
  it("trades the refresh cookie for a session", async () => {
    // The access token is memory-only, so a reload always starts with nothing.
    // The httpOnly refresh cookie is the only thing that survives.
    mocked.refreshToken.mockResolvedValue({ accessToken: "fresh" })
    mocked.verifyToken.mockResolvedValue({
      user: { _id: "u1", email: "ada@uniben.edu", role: "researcher" },
    })

    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.status).toBe("authenticated"))
    expect(result.current.user).toEqual({
      id: "u1",
      email: "ada@uniben.edu",
      role: "researcher",
    })
    expect(getAccessToken()).toBe("fresh")
  })

  it("settles as signed out when there is no cookie", async () => {
    mocked.refreshToken.mockRejectedValue(new Error("Refresh token required"))

    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.status).toBe("unauthenticated"))
    expect(result.current.user).toBeNull()
    expect(getAccessToken()).toBeNull()
  })

  it("signs out if the refreshed token does not verify", async () => {
    mocked.refreshToken.mockResolvedValue({ accessToken: "fresh" })
    mocked.verifyToken.mockRejectedValue(new Error("Invalid token"))

    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.status).toBe("unauthenticated"))
    expect(getAccessToken()).toBeNull()
  })

  it("starts in loading so a reload does not bounce to sign-in", async () => {
    // Rehydration costs a round trip. Treating that window as signed out would
    // redirect every refresh of the dashboard.
    mocked.refreshToken.mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() => useAuth(), { wrapper })

    expect(result.current.status).toBe("loading")
  })
})

describe("login", () => {
  beforeEach(() => {
    mocked.refreshToken.mockRejectedValue(new Error("no cookie"))
  })

  it("stores the token and the full user", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"))

    mocked.login.mockResolvedValue({ accessToken: "at", user: USER })

    await act(async () => {
      await result.current.login("ada@uniben.edu", "password123")
    })

    expect(result.current.status).toBe("authenticated")
    expect(result.current.user).toEqual(USER)
    expect(getAccessToken()).toBe("at")
  })

  it("propagates the server's message and stays signed out", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"))

    mocked.login.mockRejectedValue(new Error("Incorrect password"))

    await expect(
      act(async () => {
        await result.current.login("ada@uniben.edu", "wrong")
      })
    ).rejects.toThrow("Incorrect password")

    expect(result.current.status).toBe("unauthenticated")
    expect(getAccessToken()).toBeNull()
  })
})

describe("register", () => {
  it("signs the new account straight in", async () => {
    mocked.refreshToken.mockRejectedValue(new Error("no cookie"))
    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"))

    mocked.register.mockResolvedValue({ accessToken: "at", user: USER })

    await act(async () => {
      await result.current.register({
        name: "Ada Lovelace",
        email: "ada@uniben.edu",
        password: "password123",
      })
    })

    expect(result.current.status).toBe("authenticated")
    expect(result.current.user).toEqual(USER)
  })
})

describe("logout", () => {
  async function signedIn() {
    mocked.refreshToken.mockResolvedValue({ accessToken: "fresh" })
    mocked.verifyToken.mockResolvedValue({
      user: { _id: "u1", email: "ada@uniben.edu", role: "researcher" },
    })
    const hook = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(hook.result.current.status).toBe("authenticated"))
    return hook
  }

  it("clears the session", async () => {
    const { result } = await signedIn()
    mocked.logout.mockResolvedValue(undefined)

    await act(async () => {
      await result.current.logout()
    })

    expect(result.current.status).toBe("unauthenticated")
    expect(result.current.user).toBeNull()
    expect(getAccessToken()).toBeNull()
  })

  it("clears the session even when the server call fails", async () => {
    // The cookie may already be expired or revoked. Either way the local
    // session is over, so a failure must not strand the user signed in.
    const { result } = await signedIn()
    mocked.logout.mockRejectedValue(new Error("network down"))

    await act(async () => {
      await result.current.logout()
    })

    expect(result.current.status).toBe("unauthenticated")
    expect(getAccessToken()).toBeNull()
  })
})

describe("mid-session expiry", () => {
  it("signs out when a refresh fails mid-session", async () => {
    // A revoked refresh token surfaces inside the fetch layer, which React
    // state cannot observe on its own. Driven here through a real request
    // rather than by poking the handler, so the wiring is what is under test.
    mocked.refreshToken.mockResolvedValue({ accessToken: "fresh" })
    mocked.verifyToken.mockResolvedValue({
      user: { _id: "u1", email: "ada@uniben.edu", role: "researcher" },
    })

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe("authenticated"))

    // Every call now 401s, including the refresh the wrapper attempts.
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => JSON.stringify({ success: false, message: "jwt expired" }),
      json: async () => ({ success: false, message: "jwt expired" }),
    }) as unknown as typeof fetch

    await act(async () => {
      await request("/sessions").catch(() => undefined)
    })

    expect(result.current.status).toBe("unauthenticated")
    expect(result.current.user).toBeNull()
    expect(getAccessToken()).toBeNull()
  })
})
