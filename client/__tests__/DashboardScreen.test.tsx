import { StrictMode } from "react"
import { render, waitFor } from "@testing-library/react"

import { DashboardScreen } from "@/components/bci/screens/DashboardScreen"

const push = jest.fn()
const replace = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
}))

let authStatus = "authenticated"
jest.mock("@/hooks/useRequireAuth", () => ({
  useRequireAuth: () => authStatus,
}))

const engine = {
  setDashboardActive: jest.fn(),
  resetStream: jest.fn(),
  pushPacket: jest.fn(),
  configure: jest.fn(),
  registerCanvas: jest.fn(),
  registerCanvas2D: jest.fn(),
  subscribeTelemetry: jest.fn(() => () => {}),
  subscribeChannelLevels: jest.fn(() => () => {}),
}

jest.mock("@/contexts/BciEngineContext", () => ({
  useBciEngineInstance: () => engine,
}))

let sessionState: any

jest.mock("@/contexts/BciSessionContext", () => ({
  useBciSession: () => sessionState,
}))

const connect = jest.fn()
const disconnect = jest.fn()
const sendControl = jest.fn()

jest.mock("@/hooks/useEegStream", () => ({
  useEegStream: () => ({
    status: "streaming",
    error: null,
    config: null,
    filters: null,
    connect,
    disconnect,
    sendControl,
  }),
}))

beforeEach(() => {
  jest.clearAllMocks()
  authStatus = "authenticated"
  sessionState = {
    src: "sim",
    bandpassLo: 8,
    bandpassHi: 30,
    notchOn: true,
    setBandpass: jest.fn(),
    toggleNotch: jest.fn(),
    setActiveSession: jest.fn(),
    activeSession: { sessionId: "s1", mode: "simulation" },
  }
})

describe("opening the stream", () => {
  it("sends INIT once, with the session's starting filters", async () => {
    render(<DashboardScreen />)

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    expect(connect).toHaveBeenCalledWith({
      sessionId: "s1",
      mode: "simulation",
      datasetId: undefined,
      hardwareWsUrl: undefined,
      notch: true,
      bandpassLow: 8,
      bandpassHigh: 30,
    })
  })

  it("connects exactly once under Strict Mode's double mount", async () => {
    // The server rejects a second INIT for a session that has left `pending`,
    // so a duplicate connect does not merely waste a socket — it reports an
    // error on a stream that is working.
    render(
      <StrictMode>
        <DashboardScreen />
      </StrictMode>
    )

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    // Give any stray deferred attempt a chance to fire before asserting.
    await new Promise((r) => setTimeout(r, 20))
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it("clears the previous session's data before streaming", async () => {
    render(<DashboardScreen />)

    await waitFor(() => expect(engine.resetStream).toHaveBeenCalled())
  })

  it("carries the dataset through for an upload session", async () => {
    sessionState.activeSession = { sessionId: "s2", mode: "upload", datasetId: "d1" }
    render(<DashboardScreen />)

    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith(expect.objectContaining({ datasetId: "d1" }))
    )
  })

  it("carries the bridge URL through for a hardware session", async () => {
    sessionState.activeSession = {
      sessionId: "s3",
      mode: "hardware",
      hardwareWsUrl: "ws://localhost:8080",
    }
    render(<DashboardScreen />)

    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({ hardwareWsUrl: "ws://localhost:8080" })
      )
    )
  })

  it("does not reconnect when the filter controls change", async () => {
    // Retuning goes over CONTROL. Reopening the socket would restart the
    // recording from the top and lose the session's history.
    const { rerender } = render(<DashboardScreen />)
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))

    sessionState = { ...sessionState, bandpassLo: 13 }
    rerender(<DashboardScreen />)
    await new Promise((r) => setTimeout(r, 20))

    expect(connect).toHaveBeenCalledTimes(1)
  })
})

describe("guards", () => {
  it("waits rather than connecting while auth is still rehydrating", async () => {
    authStatus = "loading"
    render(<DashboardScreen />)

    await new Promise((r) => setTimeout(r, 20))
    expect(connect).not.toHaveBeenCalled()
  })

  it("sends the user to pick a source when there is no session to stream", async () => {
    // A direct URL hit or a reload has nothing to stream.
    sessionState.activeSession = null
    render(<DashboardScreen />)

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/session-init"))
    expect(connect).not.toHaveBeenCalled()
  })
})

describe("rendering lifecycle", () => {
  it("only draws while the dashboard is on screen", () => {
    const { unmount } = render(<DashboardScreen />)
    expect(engine.setDashboardActive).toHaveBeenCalledWith(true)

    unmount()
    expect(engine.setDashboardActive).toHaveBeenLastCalledWith(false)
  })
})
