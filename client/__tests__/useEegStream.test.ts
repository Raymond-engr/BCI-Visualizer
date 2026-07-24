import { act, renderHook } from "@testing-library/react"

import { useEegStream, type ConnectOptions } from "@/hooks/useEegStream"
import { setAccessToken } from "@/lib/api/client"
import type { DataPacket, StreamConfig } from "@/lib/bci/stream"

/** Rerender props for the cases that swap the packet handler mid-stream. */
type HandlerProps = { cb: (packet: DataPacket) => void }
type Stream = ReturnType<typeof useEegStream>

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  sent: string[] = []
  closedWith: { code?: number; reason?: string } | null = null

  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close(code?: number, reason?: string) {
    if (this.readyState === MockWebSocket.CLOSED) return
    this.readyState = MockWebSocket.CLOSED
    this.closedWith = { code, reason }
    this.onclose?.()
  }

  // ---- test drivers ----
  accept() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  deliver(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  fail() {
    this.onerror?.()
  }

  /** A drop from the server's side, with no close() call from us. */
  drop() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  get frames(): any[] {
    return this.sent.map((s) => JSON.parse(s))
  }

  static get latest(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1]
  }
}

const OPTIONS: ConnectOptions = { sessionId: "65f", mode: "simulation" }

function streamConfig(): StreamConfig {
  return {
    mode: "simulation",
    sampleRate: 250,
    channelNames: ["C3", "Cz", "C4"],
    packetSamples: 10,
    epochSamples: 1000,
    stepSamples: 250,
    speed: 1,
    labels: ["left_hand", "right_hand", "feet"],
    filters: { bandpassLow: 8, bandpassHigh: 30, notch: true },
    hasGroundTruth: true,
  }
}

beforeEach(() => {
  MockWebSocket.instances = []
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket
  setAccessToken("token-abc")
})

describe("INIT handshake", () => {
  it("connects to the configured socket URL", () => {
    const { result } = renderHook(() => useEegStream())
    act(() => result.current.connect(OPTIONS))

    expect(MockWebSocket.latest.url).toBe("ws://api.test/ws/stream")
    expect(result.current.status).toBe("connecting")
  })

  it("sends the access token in INIT, since a socket carries no headers", () => {
    const { result } = renderHook(() => useEegStream())
    act(() => result.current.connect(OPTIONS))
    act(() => MockWebSocket.latest.accept())

    expect(MockWebSocket.latest.frames[0]).toEqual({
      type: "INIT",
      token: "token-abc",
      sessionId: "65f",
      mode: "simulation",
    })
  })

  it("forwards the mode-specific fields the server requires", () => {
    const { result } = renderHook(() => useEegStream())
    act(() =>
      result.current.connect({
        sessionId: "65f",
        mode: "upload",
        datasetId: "65a",
        bandpassLow: 13,
        bandpassHigh: 30,
        notch: false,
      })
    )
    act(() => MockWebSocket.latest.accept())

    expect(MockWebSocket.latest.frames[0]).toMatchObject({
      mode: "upload",
      datasetId: "65a",
      bandpassLow: 13,
      bandpassHigh: 30,
      notch: false,
    })
  })

  it("refuses to open a socket when signed out", () => {
    setAccessToken(null)
    const { result } = renderHook(() => useEegStream())
    act(() => result.current.connect(OPTIONS))

    expect(MockWebSocket.instances).toHaveLength(0)
    expect(result.current.status).toBe("error")
    expect(result.current.error).toMatch(/not signed in/i)
  })
})

describe("STATUS frames", () => {
  it("adopts the config STARTED carries", () => {
    const onConfig = jest.fn()
    const { result } = renderHook(() => useEegStream({ onConfig }))
    act(() => result.current.connect(OPTIONS))
    act(() => MockWebSocket.latest.accept())

    const config = streamConfig()
    act(() =>
      MockWebSocket.latest.deliver({
        type: "STATUS",
        status: "STARTED",
        message: "Session started",
        config,
      })
    )

    expect(result.current.status).toBe("streaming")
    expect(result.current.config).toEqual(config)
    expect(result.current.filters).toEqual(config.filters)
    expect(onConfig).toHaveBeenCalledWith(config)
  })

  it("updates the filters in force when a CONTROL frame is APPLIED", () => {
    const { result } = renderHook(() => useEegStream())
    act(() => result.current.connect(OPTIONS))
    act(() => MockWebSocket.latest.accept())
    act(() =>
      MockWebSocket.latest.deliver({
        type: "STATUS",
        status: "STARTED",
        message: "",
        config: streamConfig(),
      })
    )

    act(() =>
      MockWebSocket.latest.deliver({
        type: "STATUS",
        status: "APPLIED",
        message: "Filter settings updated",
        filters: { bandpassLow: 13, bandpassHigh: 30, notch: false },
      })
    )

    expect(result.current.filters).toEqual({
      bandpassLow: 13,
      bandpassHigh: 30,
      notch: false,
    })
    expect(result.current.status).toBe("streaming")
  })

  it("keeps streaming when a filter change is rejected", () => {
    // The server rejects an unsupported band before mutating anything and
    // echoes back what is still in force. A bad input must not kill a session.
    const { result } = renderHook(() => useEegStream())
    act(() => result.current.connect(OPTIONS))
    act(() => MockWebSocket.latest.accept())
    act(() =>
      MockWebSocket.latest.deliver({
        type: "STATUS",
        status: "STARTED",
        message: "",
        config: streamConfig(),
      })
    )

    act(() =>
      MockWebSocket.latest.deliver({
        type: "STATUS",
        status: "ERROR",
        message: "No filter is available for 9-31 Hz.",
        filters: { bandpassLow: 8, bandpassHigh: 30, notch: true },
      })
    )

    expect(result.current.status).toBe("streaming")
    expect(result.current.error).toMatch(/No filter is available/)
    expect(result.current.filters).toEqual({
      bandpassLow: 8,
      bandpassHigh: 30,
      notch: true,
    })
  })

  it("treats an ERROR with no filters as fatal", () => {
    const { result } = renderHook(() => useEegStream())
    act(() => result.current.connect(OPTIONS))
    act(() => MockWebSocket.latest.accept())
    act(() =>
      MockWebSocket.latest.deliver({
        type: "STATUS",
        status: "ERROR",
        message: "Unknown sessionId",
      })
    )

    expect(result.current.status).toBe("error")
    expect(result.current.error).toBe("Unknown sessionId")
  })

  it("clears a stale rejection message once a later change applies", () => {
    const { result } = renderHook(() => useEegStream())
    act(() => result.current.connect(OPTIONS))
    act(() => MockWebSocket.latest.accept())
    act(() =>
      MockWebSocket.latest.deliver({
        type: "STATUS",
        status: "ERROR",
        message: "No filter is available for 9-31 Hz.",
        filters: { bandpassLow: 8, bandpassHigh: 30, notch: true },
      })
    )
    act(() =>
      MockWebSocket.latest.deliver({
        type: "STATUS",
        status: "APPLIED",
        message: "",
        filters: { bandpassLow: 13, bandpassHigh: 30, notch: true },
      })
    )

    expect(result.current.error).toBeNull()
  })

  it("completes, and the server's close afterwards is not an error", () => {
    const { result } = renderHook(() => useEegStream())
    act(() => result.current.connect(OPTIONS))
    act(() => MockWebSocket.latest.accept())
    act(() =>
      MockWebSocket.latest.deliver({
        type: "STATUS",
        status: "COMPLETED",
        message: "Session complete",
      })
    )
    act(() => MockWebSocket.latest.drop())

    expect(result.current.status).toBe("completed")
    expect(result.current.error).toBeNull()
  })
})

describe("data packets", () => {
  it("hands packets straight to the consumer", () => {
    const onPacket = jest.fn()
    const { result } = renderHook(() => useEegStream({ onPacket }))
    act(() => result.current.connect(OPTIONS))
    act(() => MockWebSocket.latest.accept())

    const packet: DataPacket = {
      type: "DATA_PACKET",
      timestamp: 1.25,
      samples: [[1, 2]],
      channelNames: ["C3"],
      epochIndex: 3,
    }
    act(() => MockWebSocket.latest.deliver(packet))

    expect(onPacket).toHaveBeenCalledWith(packet)
  })

  it("ignores an unparseable frame instead of tearing down", () => {
    const onPacket = jest.fn()
    const { result } = renderHook(() => useEegStream({ onPacket }))
    act(() => result.current.connect(OPTIONS))
    act(() => MockWebSocket.latest.accept())
    act(() =>
      MockWebSocket.latest.deliver({
        type: "STATUS",
        status: "STARTED",
        message: "",
        config: streamConfig(),
      })
    )

    act(() => MockWebSocket.latest.onmessage?.({ data: "not json{" }))

    expect(onPacket).not.toHaveBeenCalled()
    expect(result.current.status).toBe("streaming")
  })

  it("does not reopen the socket when the packet handler changes identity", () => {
    // Packets arrive 25x a second and consumers pass inline closures, so a
    // callback in the dep chain would restart the recording on every render.
    const { result, rerender } = renderHook<Stream, HandlerProps>(
      ({ cb }) => useEegStream({ onPacket: cb }),
      { initialProps: { cb: jest.fn() } }
    )
    act(() => result.current.connect(OPTIONS))
    const first = result.current.connect

    rerender({ cb: jest.fn() })

    expect(result.current.connect).toBe(first)
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it("routes packets to the newest handler", () => {
    const second = jest.fn()
    const { result, rerender } = renderHook<Stream, HandlerProps>(
      ({ cb }) => useEegStream({ onPacket: cb }),
      { initialProps: { cb: jest.fn() } }
    )
    act(() => result.current.connect(OPTIONS))
    act(() => MockWebSocket.latest.accept())

    rerender({ cb: second })
    act(() =>
      MockWebSocket.latest.deliver({
        type: "DATA_PACKET",
        timestamp: 0,
        samples: [[1]],
        channelNames: ["C3"],
        epochIndex: 0,
      })
    )

    expect(second).toHaveBeenCalled()
  })
})

describe("CONTROL frames", () => {
  function streamingHook() {
    const hook = renderHook(() => useEegStream())
    act(() => hook.result.current.connect(OPTIONS))
    act(() => MockWebSocket.latest.accept())
    act(() =>
      MockWebSocket.latest.deliver({
        type: "STATUS",
        status: "STARTED",
        message: "",
        config: streamConfig(),
      })
    )
    return hook
  }

  it("retunes a live stream rather than reconnecting", () => {
    // Reopening the socket would restart the recording from the top and lose
    // the session's history.
    const { result } = streamingHook()

    let sent = false
    act(() => {
      sent = result.current.sendControl({ bandpassLow: 13, bandpassHigh: 30, notch: true })
    })

    expect(sent).toBe(true)
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.latest.frames.at(-1)).toEqual({
      type: "CONTROL",
      bandpassLow: 13,
      bandpassHigh: 30,
      notch: true,
    })
  })

  it("reports failure rather than throwing when the socket is not open", () => {
    const { result } = renderHook(() => useEegStream())

    let sent = true
    act(() => {
      sent = result.current.sendControl({ notch: false })
    })

    expect(sent).toBe(false)
  })
})

describe("teardown", () => {
  it("closes the socket and goes idle on disconnect", () => {
    const { result } = renderHook(() => useEegStream())
    act(() => result.current.connect(OPTIONS))
    act(() => MockWebSocket.latest.accept())

    const socket = MockWebSocket.latest
    act(() => result.current.disconnect())

    expect(socket.closedWith?.code).toBe(1000)
    expect(result.current.status).toBe("idle")
    expect(result.current.error).toBeNull()
  })

  it("closes the socket on unmount", () => {
    // The server holds a signal processor and an interval per connection, so a
    // dashboard left behind must not leave it streaming into a dead socket.
    const { result, unmount } = renderHook(() => useEegStream())
    act(() => result.current.connect(OPTIONS))
    act(() => MockWebSocket.latest.accept())

    const socket = MockWebSocket.latest
    unmount()

    expect(socket.readyState).toBe(MockWebSocket.CLOSED)
  })

  it("reports an unexpected drop mid-stream", () => {
    const { result } = renderHook(() => useEegStream())
    act(() => result.current.connect(OPTIONS))
    act(() => MockWebSocket.latest.accept())
    act(() =>
      MockWebSocket.latest.deliver({
        type: "STATUS",
        status: "STARTED",
        message: "",
        config: streamConfig(),
      })
    )

    act(() => MockWebSocket.latest.drop())

    expect(result.current.status).toBe("error")
    expect(result.current.error).toMatch(/disconnected/i)
  })

  it("reports a connection failure", () => {
    const { result } = renderHook(() => useEegStream())
    act(() => result.current.connect(OPTIONS))
    act(() => MockWebSocket.latest.fail())

    expect(result.current.status).toBe("error")
    expect(result.current.error).toMatch(/could not reach/i)
  })

  it("replaces an existing socket when connect is called again", () => {
    const { result } = renderHook(() => useEegStream())
    act(() => result.current.connect(OPTIONS))
    const first = MockWebSocket.latest
    act(() => first.accept())

    act(() => result.current.connect({ sessionId: "other", mode: "simulation" }))

    expect(first.readyState).toBe(MockWebSocket.CLOSED)
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(result.current.status).toBe("connecting")
  })
})
