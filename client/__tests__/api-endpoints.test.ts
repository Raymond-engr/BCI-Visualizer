import { uploadDataset } from "@/lib/api/datasets"
import { getPreferenceOptions, updatePreferences } from "@/lib/api/preferences"
import {
  createSession,
  exportSessionCSV,
  getSummary,
  listSessions,
} from "@/lib/api/sessions"
import { setAccessToken } from "@/lib/api/client"

const API = "http://api.test/api/v1"

function reply(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response
}

const fetchMock = jest.fn()

beforeEach(() => {
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
  setAccessToken("token")
})

describe("sessions", () => {
  it("reserves a session over REST before the socket opens", async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: true, message: "", data: { _id: "s1" } }))

    await expect(createSession({ mode: "simulation" })).resolves.toEqual({ _id: "s1" })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${API}/sessions`)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body)).toEqual({ mode: "simulation" })
  })

  it("passes the datasetId an upload session requires", async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: true, message: "", data: {} }))

    await createSession({ mode: "upload", datasetId: "d1" })

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      mode: "upload",
      datasetId: "d1",
    })
  })

  it("builds a query string only from the filters given", async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ success: true, message: "", data: { sessions: [], pagination: {} } })
    )

    await listSessions({ limit: 50, mode: "simulation" })

    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/sessions?limit=50&mode=simulation`)
  })

  it("omits the query string entirely when unfiltered", async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ success: true, message: "", data: { sessions: [], pagination: {} } })
    )

    await listSessions()

    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/sessions`)
  })

  it("reads the summary from the results route, not the sessions route", async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: true, message: "", data: { accuracy: null } }))

    await getSummary("s1")

    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/results/s1/summary`)
  })
})

describe("CSV export", () => {
  let anchor: HTMLAnchorElement
  let created: string[]
  let revoked: string[]

  function rawResponse(disposition?: string): Response {
    return {
      ok: true,
      status: 200,
      statusText: "",
      blob: async () => new Blob(["epoch_index\n"], { type: "text/csv" }),
      headers: { get: (k: string) => (k === "Content-Disposition" ? disposition ?? null : null) },
    } as unknown as Response
  }

  beforeEach(() => {
    created = []
    revoked = []
    URL.createObjectURL = jest.fn(() => {
      const url = `blob:${created.length}`
      created.push(url)
      return url
    })
    URL.revokeObjectURL = jest.fn((url: string) => revoked.push(url))

    anchor = document.createElement("a")
    anchor.click = jest.fn()
    jest.spyOn(document, "createElement").mockReturnValue(anchor)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("takes the filename the server sets", async () => {
    // The endpoint streams and sets Content-Disposition, but it also needs a
    // Bearer header, so a plain anchor href would 401.
    fetchMock.mockResolvedValueOnce(
      rawResponse('attachment; filename="session-65f-2026-07-14.csv"')
    )

    await exportSessionCSV("65f", "fallback.csv")

    expect(anchor.download).toBe("session-65f-2026-07-14.csv")
    expect(anchor.click).toHaveBeenCalled()
  })

  it("falls back when the header is absent", async () => {
    fetchMock.mockResolvedValueOnce(rawResponse(undefined))

    await exportSessionCSV("65f", "fallback.csv")

    expect(anchor.download).toBe("fallback.csv")
  })

  it("releases the object URL it created", async () => {
    fetchMock.mockResolvedValueOnce(rawResponse('attachment; filename="a.csv"'))

    await exportSessionCSV("65f", "fallback.csv")

    expect(revoked).toEqual(created)
  })

  it("sends the Bearer token the export route requires", async () => {
    fetchMock.mockResolvedValueOnce(rawResponse('attachment; filename="a.csv"'))

    await exportSessionCSV("65f", "fallback.csv")

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer token")
  })
})

describe("datasets", () => {
  it("posts the recording as multipart", async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: true, message: "", data: { _id: "d1" } }))
    const file = new File(["data"], "A01T.gdf")

    await uploadDataset(file)

    const init = fetchMock.mock.calls[0][1]
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get("file")).toBe(file)
    expect(init.headers["Content-Type"]).toBeUndefined()
  })

  it("includes subjectId only when given", async () => {
    fetchMock.mockResolvedValue(reply({ success: true, message: "", data: {} }))
    const file = new File(["data"], "A01T.gdf")

    await uploadDataset(file)
    expect((fetchMock.mock.calls[0][1].body as FormData).get("subjectId")).toBeNull()

    await uploadDataset(file, "s1")
    expect((fetchMock.mock.calls[1][1].body as FormData).get("subjectId")).toBe("s1")
  })
})

describe("preferences", () => {
  it("sends only the settings the server acts on", async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: true, message: "", data: {} }))

    await updatePreferences({ bandpassLow: 13, bandpassHigh: 30, notchEnabled: false })

    const init = fetchMock.mock.calls[0][1]
    expect(init.method).toBe("PUT")
    expect(JSON.parse(init.body)).toEqual({
      bandpassLow: 13,
      bandpassHigh: 30,
      notchEnabled: false,
    })
  })

  it("surfaces the server's rejection of an unsupported band", async () => {
    // Coefficients are precomputed, so an arbitrary band cannot be honoured.
    fetchMock.mockResolvedValueOnce(
      reply(
        {
          success: false,
          message: "No filter is available for 9-31 Hz. Supported bands: 8–30 Hz, 4–40 Hz.",
        },
        400
      )
    )

    await expect(updatePreferences({ bandpassLow: 9, bandpassHigh: 31 })).rejects.toThrow(
      /No filter is available/
    )
  })

  it("reads the deployment's fixed constants from options", async () => {
    fetchMock.mockResolvedValueOnce(
      reply({
        success: true,
        message: "",
        data: { sampleRate: 250, epochSeconds: 4, notchFreq: 50, bandpassOptions: [] },
      })
    )

    await expect(getPreferenceOptions()).resolves.toMatchObject({
      sampleRate: 250,
      epochSeconds: 4,
      notchFreq: 50,
    })
  })
})
