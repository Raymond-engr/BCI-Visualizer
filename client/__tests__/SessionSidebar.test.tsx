import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SessionSidebar } from "@/components/bci/dashboard/SessionSidebar"
import type { EegStream, StreamStatus } from "@/hooks/useEegStream"
import { updatePreferences } from "@/lib/api/preferences"
import { CHAN } from "@/lib/bci/constants"

/**
 * jsdom implements no PointerEvent, and Base UI's Switch forwards its click to
 * the hidden checkbox as one. The notch toggle cannot be exercised at all
 * without this — the gap is the environment's, not the component's.
 */
if (typeof window.PointerEvent === "undefined") {
  window.PointerEvent = class extends MouseEvent {} as any
}

const push = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
}))

// The sidebar only ever subscribes to the engine and asks it to reset; stubbing
// it keeps the suite away from WebGL, which jsdom does not have.
let onTelemetry: ((t: { sessionTime: string }) => void) | null = null

const engine = {
  resetStream: jest.fn(),
  subscribeTelemetry: jest.fn((cb: (t: { sessionTime: string }) => void) => {
    onTelemetry = cb
    return () => {}
  }),
  subscribeChannelLevels: jest.fn(() => () => {}),
}

jest.mock("@/contexts/BciEngineContext", () => ({
  useBciEngineInstance: () => engine,
}))

let sessionState: any

jest.mock("@/contexts/BciSessionContext", () => ({
  useBciSession: () => sessionState,
}))

jest.mock("@/lib/api/preferences")

const mockedUpdate = updatePreferences as jest.MockedFunction<typeof updatePreferences>

const connect = jest.fn()
const disconnect = jest.fn()
const sendControl = jest.fn()

function makeStream(overrides: Partial<EegStream> = {}): EegStream {
  return {
    status: "streaming",
    error: null,
    config: null,
    filters: null,
    connect,
    disconnect,
    sendControl,
    ...overrides,
  }
}

/** Mirrors FILTER_DEBOUNCE_MS in the component, which is not exported. */
const DEBOUNCE_MS = 700

beforeEach(() => {
  jest.clearAllMocks()
  onTelemetry = null
  mockedUpdate.mockResolvedValue({} as any)
  sessionState = {
    src: "sim",
    bandpassLo: 8,
    bandpassHi: 30,
    // The provider re-renders with the new band, so the mock tracks it too.
    setBandpass: jest.fn((lo: number, hi: number) => {
      sessionState.bandpassLo = lo
      sessionState.bandpassHi = hi
    }),
    notchOn: true,
    toggleNotch: jest.fn(() => {
      sessionState.notchOn = !sessionState.notchOn
    }),
    setActiveSession: jest.fn(),
  }
})

describe("stream status", () => {
  it.each([
    ["idle", "IDLE"],
    ["connecting", "CONNECTING"],
    ["streaming", "STREAMING"],
    // "COMPLETE" is the badge's vocabulary; the stream's own word is "completed".
    ["completed", "COMPLETE"],
    ["error", "ERROR"],
  ])("announces a %s stream as %s", (status, label) => {
    render(<SessionSidebar stream={makeStream({ status: status as StreamStatus })} />)

    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it("names the source the session was started from", () => {
    sessionState.src = "upload"
    render(<SessionSidebar stream={makeStream()} />)

    expect(screen.getByText("DATASET")).toBeInTheDocument()
  })
})

describe("the channel list", () => {
  it("follows the montage the stream reports rather than a fixed one", () => {
    // A recording may carry any montage, so the sidebar must not assume the
    // 22-electrode default once the server has said what it is sending.
    const stream = makeStream({
      config: { channelNames: ["C3", "Cz", "C4"] } as any,
    })
    render(<SessionSidebar stream={stream} />)

    expect(screen.getByText("CHANNELS · 3")).toBeInTheDocument()
    expect(screen.getByText("C3")).toBeInTheDocument()
    expect(screen.getByText("Cz")).toBeInTheDocument()
    expect(screen.getByText("C4")).toBeInTheDocument()
  })

  it("falls back to the default montage before the stream has reported one", () => {
    // STARTED carries the config, so there is a real window between opening the
    // socket and knowing the montage; the panel must render through it.
    render(<SessionSidebar stream={makeStream({ config: null })} />)

    expect(screen.getByText(`CHANNELS · ${CHAN.length}`)).toBeInTheDocument()
    expect(screen.getByText("Fz")).toBeInTheDocument()
    expect(screen.getByText("POz")).toBeInTheDocument()
  })
})

describe("retuning the filters", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("collapses a rapid burst of bandpass edits into a single CONTROL frame", () => {
    // Every keystroke in "13" is a band the user is passing through, not one
    // they asked for. Sending each would retune the running signal processor
    // several times over and ask the server to reject bands nobody chose.
    render(<SessionSidebar stream={makeStream()} />)
    const [lo] = screen.getAllByRole("textbox")

    fireEvent.change(lo, { target: { value: "9" } })
    fireEvent.change(lo, { target: { value: "12" } })
    fireEvent.change(lo, { target: { value: "13" } })

    // The local controls track every keystroke; the socket must not.
    expect(sessionState.setBandpass).toHaveBeenCalledTimes(3)
    expect(sendControl).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS - 1)
    })
    expect(sendControl).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(sendControl).toHaveBeenCalledTimes(1)
    expect(sendControl).toHaveBeenCalledWith({
      bandpassLow: 13,
      bandpassHigh: 30,
      notch: true,
    })
  })

  it("retunes the upper edge of the band from its own field", () => {
    render(<SessionSidebar stream={makeStream()} />)
    const [, hi] = screen.getAllByRole("textbox")

    fireEvent.change(hi, { target: { value: "24" } })
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS)
    })

    expect(sendControl).toHaveBeenCalledWith({
      bandpassLow: 8,
      bandpassHigh: 24,
      notch: true,
    })
  })

  it("applies a notch toggle immediately, without waiting out the debounce", async () => {
    // A switch is a decision, not a keystroke — there is no burst to wait for,
    // and mains hum is what the user is looking at while they flip it.
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    render(<SessionSidebar stream={makeStream()} />)

    await user.click(screen.getByRole("switch"))

    expect(sessionState.toggleNotch).toHaveBeenCalled()
    expect(sendControl).toHaveBeenCalledTimes(1)
    expect(sendControl).toHaveBeenCalledWith({
      bandpassLow: 8,
      bandpassHigh: 30,
      notch: false,
    })
  })

  it("lets a notch toggle carry a band edit that is still waiting", async () => {
    // Both live on one CONTROL frame, so the immediate notch supersedes the
    // pending band rather than racing it — the band still reaches the server.
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    const stream = makeStream()
    const { rerender } = render(<SessionSidebar stream={stream} />)
    const [lo] = screen.getAllByRole("textbox")

    fireEvent.change(lo, { target: { value: "13" } })
    // Stand in for the provider re-rendering with the band it just accepted.
    rerender(<SessionSidebar stream={stream} />)

    await user.click(screen.getByRole("switch"))

    expect(sendControl).toHaveBeenCalledTimes(1)
    expect(sendControl).toHaveBeenCalledWith({
      bandpassLow: 13,
      bandpassHigh: 30,
      notch: false,
    })

    // The superseded band must not arrive a second time once the timer expires.
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS)
    })
    expect(sendControl).toHaveBeenCalledTimes(1)
  })

  it("never reopens the socket to retune", async () => {
    // Reconnecting would restart the recording from the top and lose the
    // session's history, which is the whole reason CONTROL exists.
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    render(<SessionSidebar stream={makeStream()} />)
    const [lo] = screen.getAllByRole("textbox")

    fireEvent.change(lo, { target: { value: "13" } })
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS)
    })
    await user.click(screen.getByRole("switch"))

    expect(sendControl).toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it("persists the retuned filters so the next session starts on them", () => {
    render(<SessionSidebar stream={makeStream()} />)
    const [lo] = screen.getAllByRole("textbox")

    fireEvent.change(lo, { target: { value: "13" } })
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS)
    })

    // REST calls the flag `notchEnabled`; the socket calls it `notch`.
    expect(mockedUpdate).toHaveBeenCalledTimes(1)
    expect(mockedUpdate).toHaveBeenCalledWith({
      bandpassLow: 13,
      bandpassHigh: 30,
      notchEnabled: true,
    })
  })

  it("keeps the stream running when the preference write fails", async () => {
    // The socket's reply is what the user acts on. A failed write is worth no
    // alert of its own and must not take the dashboard down with it.
    mockedUpdate.mockRejectedValue(new Error("Network request failed"))
    render(<SessionSidebar stream={makeStream()} />)
    const [lo] = screen.getAllByRole("textbox")

    fireEvent.change(lo, { target: { value: "13" } })
    await act(async () => {
      jest.advanceTimersByTime(DEBOUNCE_MS)
    })

    expect(sendControl).toHaveBeenCalledTimes(1)
    expect(screen.getByText("STREAMING")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("drops a pending retune when the sidebar goes away", () => {
    // The dashboard closes the socket on its way out, so a frame that fires
    // afterwards would be written to a connection that is already gone.
    const { unmount } = render(<SessionSidebar stream={makeStream()} />)
    const [lo] = screen.getAllByRole("textbox")

    fireEvent.change(lo, { target: { value: "13" } })
    unmount()

    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS)
    })
    expect(sendControl).not.toHaveBeenCalled()
    expect(mockedUpdate).not.toHaveBeenCalled()
  })
})

describe("the session clock", () => {
  it("shows the engine's time without waiting for a render", () => {
    // Telemetry arrives with the packets, far faster than React should re-run
    // the sidebar for, so the engine writes the clock straight into the DOM.
    render(<SessionSidebar stream={makeStream()} />)
    expect(screen.getByText("00:00:00")).toBeInTheDocument()

    act(() => onTelemetry?.({ sessionTime: "00:01:23" }))

    expect(screen.getByText("00:01:23")).toBeInTheDocument()
  })
})

describe("errors from the server", () => {
  it("shows a rejected band as an alert while the stream keeps running", () => {
    // Coefficients are precomputed, so an unsupported band is refused before
    // anything changes — the previous filter is still live and must look it.
    const stream = makeStream({
      status: "streaming",
      error: "Unsupported bandpass band: 3-90 Hz",
    })
    render(<SessionSidebar stream={stream} />)

    expect(screen.getByRole("alert")).toHaveTextContent(/Unsupported bandpass band/i)
    expect(screen.getByText("STREAMING")).toBeInTheDocument()
  })

  it("stays quiet when nothing is wrong", () => {
    render(<SessionSidebar stream={makeStream()} />)

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})

describe("stopping the session", () => {
  it("closes the socket, clears the session and leaves the dashboard", async () => {
    // The server holds a signal processor and an interval per connection, so
    // walking away without closing leaves it streaming into nothing.
    const user = userEvent.setup()
    render(<SessionSidebar stream={makeStream()} />)

    await user.click(screen.getByRole("button", { name: /Stop Session/ }))

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(sessionState.setActiveSession).toHaveBeenCalledWith(null)
    expect(engine.resetStream).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith("/")
  })
})
