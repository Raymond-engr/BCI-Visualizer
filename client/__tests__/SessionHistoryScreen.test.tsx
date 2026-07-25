import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SessionHistoryScreen } from "@/components/bci/screens/SessionHistoryScreen"
import { exportSessionCSV, getSession, listSessions } from "@/lib/api/sessions"
import type { Session, SessionDetailPayload } from "@/lib/api/types"

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))

let authStatus = "authenticated"
jest.mock("@/hooks/useRequireAuth", () => ({
  useRequireAuth: () => authStatus,
}))

jest.mock("@/lib/api/sessions")

const mockedList = listSessions as jest.MockedFunction<typeof listSessions>
const mockedGet = getSession as jest.MockedFunction<typeof getSession>
const mockedExport = exportSessionCSV as jest.MockedFunction<typeof exportSessionCSV>

function session(overrides: Partial<Session> & { _id: string }): Session {
  return {
    userId: "u1",
    mode: "upload",
    status: "completed",
    modelId: "eegnet-v1",
    epochCount: 100,
    startTime: "2025-11-03T10:00:00.000Z",
    durationSeconds: 300,
    createdAt: "2025-11-03T10:00:00.000Z",
    sourceLabel: "A01T.gdf",
    hasGroundTruth: true,
    ...overrides,
  } as Session
}

/** A scored recording: cue events exist, so the server can report accuracy. */
const UPLOAD = session({
  _id: "s1",
  mode: "upload",
  sourceLabel: "A01T.gdf",
  accuracy: 0.812,
  hasGroundTruth: true,
})

/** A live headset: no cues were ever presented, so accuracy is null. */
const HARDWARE = session({
  _id: "s2",
  mode: "hardware",
  sourceLabel: "OpenBCI Cyton",
  accuracy: null,
  hasGroundTruth: false,
  durationSeconds: 125,
})

const PAGINATION = { page: 1, limit: 50, total: 2, pages: 1 }

function detail(breakdown: SessionDetailPayload["breakdown"]): SessionDetailPayload {
  return { session: UPLOAD, breakdown }
}

beforeEach(() => {
  jest.clearAllMocks()
  authStatus = "authenticated"
  mockedList.mockResolvedValue({ sessions: [UPLOAD, HARDWARE], pagination: PAGINATION })
  mockedGet.mockResolvedValue(detail([]))
  mockedExport.mockResolvedValue(undefined)
})

describe("accuracy", () => {
  it("shows a dash rather than 0% for a session that has no ground truth", async () => {
    // The highest-value case here. A live headset emits no cue events, so its
    // accuracy is null — not zero. Rendering 0% would tell the researcher the
    // decoder got every epoch wrong, when in fact nothing was ever scored.
    render(<SessionHistoryScreen />)

    const badge = await screen.findByTitle(/No cue events/i)
    expect(badge).toHaveTextContent("—")
    expect(screen.queryByText("0.0%")).not.toBeInTheDocument()
  })

  it("reports a scored session's accuracy as a percentage", async () => {
    render(<SessionHistoryScreen />)

    expect(await screen.findByText("81.2%")).toBeInTheDocument()
  })

  it("explains in the badge's tooltip why accuracy is unavailable", async () => {
    // The dash is meaningless on its own; the reason it can never exist for a
    // headset session is what stops it reading as a loading state or a bug.
    render(<SessionHistoryScreen />)

    await screen.findByText("A01T.gdf")
    expect(screen.getByTitle(/No cue events on a live headset/i)).toBeInTheDocument()
    expect(screen.getByTitle(/Accuracy against the recording's cue events/i)).toBeInTheDocument()
  })
})

describe("the session list", () => {
  it("asks for one page big enough to cover a researcher's history", async () => {
    render(<SessionHistoryScreen />)

    await waitFor(() => expect(mockedList).toHaveBeenCalledWith({ limit: 50 }))
  })

  it("lists each session with its source and duration", async () => {
    render(<SessionHistoryScreen />)

    expect(await screen.findByText("A01T.gdf")).toBeInTheDocument()
    expect(screen.getByText("OpenBCI Cyton")).toBeInTheDocument()
    expect(screen.getByText(/05:00/)).toBeInTheDocument()
    expect(screen.getByText(/02:05/)).toBeInTheDocument()
  })

  it("waits rather than fetching while auth is still rehydrating", async () => {
    // Fetching during the rehydration window would go out without a bearer
    // token and 401 on a user who is in fact signed in.
    authStatus = "loading"
    render(<SessionHistoryScreen />)

    await new Promise((r) => setTimeout(r, 20))
    expect(mockedList).not.toHaveBeenCalled()
  })

  it("offers a way to start a session when there is no history yet", async () => {
    mockedList.mockResolvedValue({
      sessions: [],
      pagination: { page: 1, limit: 50, total: 0, pages: 0 },
    })
    render(<SessionHistoryScreen />)

    expect(await screen.findByText(/No sessions recorded yet/i)).toBeInTheDocument()
    // The Button renders its Link with an explicit role="button", so the CTA is
    // reachable as a button even though it is an anchor underneath.
    expect(screen.getByRole("button", { name: /Start a session/i })).toHaveAttribute(
      "href",
      "/session-init"
    )
  })

  it("cannot export an empty history", async () => {
    mockedList.mockResolvedValue({
      sessions: [],
      pagination: { page: 1, limit: 50, total: 0, pages: 0 },
    })
    render(<SessionHistoryScreen />)

    await screen.findByText(/No sessions recorded yet/i)
    expect(screen.getByRole("button", { name: /Export All/i })).toBeDisabled()
  })

  it("surfaces the server's reason when the history cannot be fetched", async () => {
    // A failed fetch must not read as a successful empty result, so the reason
    // the list is missing has to reach the researcher verbatim.
    mockedList.mockRejectedValue(new Error("Could not reach the API"))
    render(<SessionHistoryScreen />)

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the API")
    expect(screen.queryByText("A01T.gdf")).not.toBeInTheDocument()
  })

  it("stops the spinner when the fetch fails", async () => {
    // `finally` clears loading on the error path too; without it the page spins
    // forever behind the alert.
    mockedList.mockRejectedValue(new Error("Could not reach the API"))
    render(<SessionHistoryScreen />)

    await screen.findByRole("alert")
    expect(screen.getByRole("button", { name: /Export All/i })).toBeInTheDocument()
  })
})

describe("class breakdown", () => {
  it("reports each class's share of the epochs that were predicted", async () => {
    // The bars divide by the epochs in the breakdown, not the session's
    // epochCount — an epoch the model never classified is not a class with a
    // zero share, it is simply not in the denominator.
    mockedGet.mockResolvedValue(
      detail([
        { _id: "left_hand", count: 30 },
        { _id: "right_hand", count: 10 },
      ])
    )
    render(<SessionHistoryScreen />)

    // 30 of 40 predicted epochs, not 30 of the session's 100 recorded ones.
    expect(await screen.findByText("75%")).toBeInTheDocument()
    expect(screen.getByText("25%")).toBeInTheDocument()
    // Feet was never predicted, so it holds none of the share.
    expect(screen.getByText("0%")).toBeInTheDocument()
  })

  it("holds the bars in a fixed order even though the server sorts by count", async () => {
    // The server returns the breakdown ordered by count, so rendering it as
    // received would reshuffle the bars between sessions and make two histories
    // impossible to compare at a glance.
    mockedGet.mockResolvedValue(
      detail([
        { _id: "feet", count: 6 },
        { _id: "left_hand", count: 2 },
      ])
    )
    render(<SessionHistoryScreen />)
    await screen.findByText("75%")

    // getAllByText yields document order: feet came back first, but renders last.
    const labels = screen
      .getAllByText(/^(Left Hand|Right Hand|Feet)$/)
      .map((el) => el.textContent)
    expect(labels).toEqual(["Left Hand", "Right Hand", "Feet"])
  })

  it("still shows a class that was never predicted, at a zero share", async () => {
    // Dropping the class entirely would imply the model cannot predict it,
    // rather than that it did not on this recording.
    mockedGet.mockResolvedValue(detail([{ _id: "feet", count: 5 }]))
    render(<SessionHistoryScreen />)

    await screen.findByText("100%")
    expect(screen.getByText("Left Hand")).toBeInTheDocument()
    expect(screen.getAllByText("0%")).toHaveLength(2)
  })

  it("opens on the most recent session", async () => {
    render(<SessionHistoryScreen />)

    expect(await screen.findByText(/LATEST SESSION/)).toBeInTheDocument()
    await waitFor(() => expect(mockedGet).toHaveBeenCalledWith("s1"))
  })

  it("names the session once the researcher looks at an older one", async () => {
    const user = userEvent.setup()
    render(<SessionHistoryScreen />)
    await screen.findByText("OpenBCI Cyton")

    await user.click(screen.getAllByRole("button", { name: "View" })[1])

    await waitFor(() => expect(mockedGet).toHaveBeenCalledWith("s2"))
    expect(await screen.findByText(/OPENBCI CYTON/)).toBeInTheDocument()
  })

  it("says so plainly when a session classified nothing", async () => {
    mockedGet.mockResolvedValue(detail([]))
    render(<SessionHistoryScreen />)

    expect(
      await screen.findByText(/No epochs were classified in this session/i)
    ).toBeInTheDocument()
  })

  it("leaves the bars empty when the breakdown cannot be fetched", async () => {
    // The list already rendered; a failed aggregate should not blank the page
    // the researcher is reading.
    mockedGet.mockRejectedValue(new Error("aggregate failed"))
    render(<SessionHistoryScreen />)

    expect(
      await screen.findByText(/No epochs were classified in this session/i)
    ).toBeInTheDocument()
    expect(screen.getByText("A01T.gdf")).toBeInTheDocument()
  })
})

describe("CSV export", () => {
  it("exports one session with a filename that identifies it", async () => {
    const user = userEvent.setup()
    render(<SessionHistoryScreen />)
    await screen.findByText("A01T.gdf")

    await user.click(screen.getAllByRole("button", { name: "CSV" })[0])

    await waitFor(() => expect(mockedExport).toHaveBeenCalledWith("s1", "session-s1.csv"))
  })

  it("exports every session when asked for all of them", async () => {
    // There is no bulk endpoint, so this walks the list one session at a time.
    const user = userEvent.setup()
    render(<SessionHistoryScreen />)
    await screen.findByText("A01T.gdf")

    await user.click(screen.getByRole("button", { name: /Export All/i }))

    await waitFor(() => expect(mockedExport).toHaveBeenCalledTimes(2))
    expect(mockedExport).toHaveBeenCalledWith("s1", "session-s1.csv")
    expect(mockedExport).toHaveBeenCalledWith("s2", "session-s2.csv")
  })

  it("tells the researcher when an export fails rather than failing silently", async () => {
    // The download either happens or it doesn't; a silent failure leaves the
    // user waiting for a file that is never coming.
    mockedExport.mockRejectedValue(new Error("Export failed: session not found"))
    const user = userEvent.setup()
    render(<SessionHistoryScreen />)
    await screen.findByText("A01T.gdf")

    await user.click(screen.getAllByRole("button", { name: "CSV" })[0])

    expect(await screen.findByRole("alert")).toHaveTextContent("session not found")
  })

  it("re-enables Export All once a failed bulk export finishes", async () => {
    mockedExport.mockRejectedValue(new Error("network down"))
    const user = userEvent.setup()
    render(<SessionHistoryScreen />)
    await screen.findByText("A01T.gdf")

    await user.click(screen.getByRole("button", { name: /Export All/i }))

    expect(await screen.findByRole("alert")).toHaveTextContent("network down")
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Export All/i })).toBeEnabled()
    )
  })
})
