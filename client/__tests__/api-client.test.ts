import {
  ApiError,
  getAccessToken,
  request,
  setAccessToken,
  setUnauthorizedHandler,
} from "@/lib/api/client"

const API = "http://api.test/api/v1"

/**
 * Minimal stand-in for Response covering what the wrapper reads. Both `text`
 * and `json` are needed: request() reads the body as text so it can report a
 * non-JSON error page, while the refresh path uses json() directly.
 */
function reply(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "Status Text",
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
    json: async () => body,
  } as unknown as Response
}

function rawReply(text: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "Status Text",
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response
}

const fetchMock = jest.fn()

beforeEach(() => {
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
  setAccessToken(null)
  setUnauthorizedHandler(null)
})

describe("request", () => {
  it("unwraps the server's {success, message, data} envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ success: true, message: "ok", data: { _id: "abc" } })
    )

    await expect(request("/sessions")).resolves.toEqual({ _id: "abc" })
  })

  it("sends the access token as a Bearer header once one is set", async () => {
    setAccessToken("token-123")
    fetchMock.mockResolvedValueOnce(reply({ success: true, message: "", data: 1 }))

    await request("/sessions")

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${API}/sessions`)
    expect(init.headers.Authorization).toBe("Bearer token-123")
  })

  it("omits Authorization entirely when signed out", async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: true, message: "", data: 1 }))

    await request("/health")

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })

  it("always sends credentials so the refresh cookie rides along", async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: true, message: "", data: 1 }))

    await request("/sessions")

    expect(fetchMock.mock.calls[0][1].credentials).toBe("include")
  })

  it("serialises a JSON body and sets its content type", async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: true, message: "", data: 1 }))

    await request("/sessions", { method: "POST", body: { mode: "simulation" } })

    const init = fetchMock.mock.calls[0][1]
    expect(init.headers["Content-Type"]).toBe("application/json")
    expect(init.body).toBe(JSON.stringify({ mode: "simulation" }))
  })

  it("leaves FormData alone so the browser can set the multipart boundary", async () => {
    const form = new FormData()
    form.append("file", new Blob(["x"]), "a.gdf")
    fetchMock.mockResolvedValueOnce(reply({ success: true, message: "", data: 1 }))

    await request("/datasets/upload", { method: "POST", body: form })

    const init = fetchMock.mock.calls[0][1]
    expect(init.headers["Content-Type"]).toBeUndefined()
    expect(init.body).toBe(form)
  })

  it("surfaces the server's message on an error status", async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ success: false, message: "Upload sessions require a datasetId" }, 400)
    )

    await expect(request("/sessions", { method: "POST" })).rejects.toThrow(
      "Upload sessions require a datasetId"
    )
  })

  it("carries the status code on the thrown ApiError", async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: false, message: "Nope" }, 403))

    await expect(request("/sessions/x")).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
    })
  })

  it("treats success:false as an error even on a 200", async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: false, message: "Odd" }, 200))

    await expect(request("/sessions")).rejects.toThrow(ApiError)
  })

  it("resolves to undefined for an empty body", async () => {
    fetchMock.mockResolvedValueOnce(rawReply("", 204))

    await expect(request("/sessions/x", { method: "DELETE" })).resolves.toBeUndefined()
  })

  it("reports a non-JSON error page rather than a parse crash", async () => {
    fetchMock.mockResolvedValueOnce(rawReply("<html>502 Bad Gateway</html>", 502))

    await expect(request("/sessions")).rejects.toThrow(ApiError)
  })
})

describe("401 handling", () => {
  /**
   * Routes by URL and by which token the caller presented, so the refresh and
   * retry legs are exercised as the server would actually drive them.
   */
  function installExpiredTokenServer() {
    let refreshCalls = 0

    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (url === `${API}/auth/refresh-token`) {
        refreshCalls++
        return reply({ success: true, message: "", data: { accessToken: "fresh" } })
      }
      if (init?.headers?.Authorization === "Bearer fresh") {
        return reply({ success: true, message: "", data: "protected" })
      }
      return reply({ success: false, message: "jwt expired" }, 401)
    })

    return { refreshes: () => refreshCalls }
  }

  it("refreshes and retries once, transparently to the caller", async () => {
    setAccessToken("stale")
    const server = installExpiredTokenServer()

    await expect(request("/sessions")).resolves.toBe("protected")
    expect(server.refreshes()).toBe(1)
    expect(getAccessToken()).toBe("fresh")
  })

  it("refreshes only once when several requests expire together", async () => {
    // The server rotates the refresh token on every use, so a second concurrent
    // refresh would present one the first had already invalidated and sign the
    // user out mid-session.
    setAccessToken("stale")
    const server = installExpiredTokenServer()

    const results = await Promise.all([
      request("/sessions"),
      request("/datasets"),
      request("/preferences"),
    ])

    expect(results).toEqual(["protected", "protected", "protected"])
    expect(server.refreshes()).toBe(1)
  })

  it("clears the token and notifies when the refresh itself fails", async () => {
    setAccessToken("stale")
    const onUnauthorized = jest.fn()
    setUnauthorizedHandler(onUnauthorized)

    fetchMock.mockImplementation(async (url: string) => {
      if (url === `${API}/auth/refresh-token`) {
        return reply({ success: false, message: "Refresh token has been revoked" }, 401)
      }
      return reply({ success: false, message: "jwt expired" }, 401)
    })

    await expect(request("/sessions")).rejects.toThrow()
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(getAccessToken()).toBeNull()
  })

  it("does not let the refresh call recurse on its own 401", async () => {
    const { refreshToken } = await import("@/lib/api/auth")
    fetchMock.mockResolvedValue(reply({ success: false, message: "no cookie" }, 401))

    await expect(refreshToken()).rejects.toThrow()
    // One attempt, not an attempt plus a refresh of the refresh.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
