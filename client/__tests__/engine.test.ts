import { BciEngine, type Telemetry } from "@/lib/bci/engine"
import { CHAN, MI_COLOR, MI_PENDING, WAVE_CHANNELS } from "@/lib/bci/constants"
import type { DataPacket, StreamConfig } from "@/lib/bci/stream"

const SAMPLE_RATE = 250

function config(overrides: Partial<StreamConfig> = {}): StreamConfig {
  return {
    mode: "simulation",
    sampleRate: SAMPLE_RATE,
    channelNames: [...CHAN],
    packetSamples: 10,
    epochSamples: 1000,
    stepSamples: 250,
    speed: 1,
    labels: ["left_hand", "right_hand", "feet"],
    filters: { bandpassLow: 8, bandpassHigh: 30, notch: true },
    hasGroundTruth: true,
    ...overrides,
  }
}

/** One packet of `samples` per channel, all channels carrying `value`. */
function packet(overrides: Partial<DataPacket> = {}): DataPacket {
  return {
    type: "DATA_PACKET",
    timestamp: 0,
    samples: CHAN.map(() => new Array(10).fill(1)),
    channelNames: [...CHAN],
    epochIndex: -1,
    ...overrides,
  }
}

/**
 * Telemetry is emitted from the rAF loop, so drive the loop and grab the first
 * frame rather than reaching into private state.
 */
async function nextTelemetry(engine: BciEngine): Promise<Telemetry> {
  return new Promise((resolve) => {
    const unsubscribe = engine.subscribeTelemetry((t) => {
      unsubscribe()
      resolve(t)
    })
    engine.setDashboardActive(true)
    engine.start()
  })
}

let engine: BciEngine

beforeEach(() => {
  engine = new BciEngine()
})

afterEach(() => {
  engine.stop()
})

describe("packet ingest", () => {
  it("keeps the last analysis when later packets omit it", async () => {
    // Analysis rides on roughly 1 packet in 25. If the engine dropped it on the
    // 24 that follow, the dashboard would strobe between a class and nothing.
    engine.configure(config())
    engine.pushPacket(
      packet({
        epochIndex: 7,
        classification: {
          predictedClass: "right_hand",
          confidence: 0.81,
          allScores: { left_hand: 0.1, right_hand: 0.81, feet: 0.09 },
        },
      })
    )
    engine.pushPacket(packet({ timestamp: 0.04, epochIndex: 7 }))

    const telemetry = await nextTelemetry(engine)
    expect(telemetry.miClass).toBe("right_hand")
    expect(telemetry.confidencePct).toBeCloseTo(81, 1)
  })

  it("reports AWAITING until the first epoch closes", async () => {
    // A 4-second epoch means a real stream genuinely has nothing to predict for
    // its first few seconds. That is a fact about the pipeline, not a spinner.
    engine.configure(config())
    engine.pushPacket(packet({ epochIndex: -1 }))

    const telemetry = await nextTelemetry(engine)
    expect(telemetry.miClass).toBeNull()
    expect(telemetry.miLabel).toBe(MI_PENDING.label)
    expect(telemetry.miColor).toBe(MI_PENDING.color)
    expect(telemetry.epoch).toBe(-1)
  })

  it("colours telemetry by the predicted class", async () => {
    engine.configure(config())
    engine.pushPacket(
      packet({
        epochIndex: 1,
        classification: {
          predictedClass: "feet",
          confidence: 0.5,
          allScores: { left_hand: 0.25, right_hand: 0.25, feet: 0.5 },
        },
      })
    )

    const telemetry = await nextTelemetry(engine)
    expect(telemetry.miLabel).toBe("FEET")
    expect(telemetry.miColor).toBe(MI_COLOR.feet)
  })

  it("advances the epoch counter from the packet, not a local tally", async () => {
    engine.configure(config())
    engine.pushPacket(packet({ epochIndex: 143 }))

    expect((await nextTelemetry(engine)).epoch).toBe(143)
  })
})

describe("session clock", () => {
  it("runs on stream time, measured from the first packet", async () => {
    // Upload mode replays at 8x, so a clock driven by Date.now() would disagree
    // with the data being drawn. File-backed modes also start near zero rather
    // than at a Unix epoch.
    engine.configure(config())
    engine.pushPacket(packet({ timestamp: 100 }))
    engine.pushPacket(packet({ timestamp: 165 }))

    expect((await nextTelemetry(engine)).sessionTime).toBe("00:01:05")
  })

  it("formats past an hour", async () => {
    engine.configure(config())
    engine.pushPacket(packet({ timestamp: 0 }))
    engine.pushPacket(packet({ timestamp: 3725 }))

    expect((await nextTelemetry(engine)).sessionTime).toBe("01:02:05")
  })

  it("never runs backwards if a packet arrives out of order", async () => {
    engine.configure(config())
    engine.pushPacket(packet({ timestamp: 50 }))
    engine.pushPacket(packet({ timestamp: 40 }))

    expect((await nextTelemetry(engine)).sessionTime).toBe("00:00:00")
  })

  it("resets the clock between sessions", async () => {
    engine.configure(config())
    engine.pushPacket(packet({ timestamp: 500 }))
    engine.pushPacket(packet({ timestamp: 560 }))
    engine.resetStream()
    engine.pushPacket(packet({ timestamp: 900 }))

    expect((await nextTelemetry(engine)).sessionTime).toBe("00:00:00")
  })
})

describe("channel levels", () => {
  it("emits one level per channel in the stream's montage", async () => {
    engine.configure(config())
    engine.pushPacket(packet())

    const levels = await new Promise<readonly number[]>((resolve) => {
      const unsubscribe = engine.subscribeChannelLevels((l) => {
        unsubscribe()
        resolve([...l])
      })
      engine.setDashboardActive(true)
      engine.start()
    })

    expect(levels).toHaveLength(CHAN.length)
  })

  it("ranks a loud channel above a quiet one", async () => {
    engine.configure(config())
    const samples = CHAN.map((_, i) => new Array(10).fill(i === 0 ? 50 : 1))
    // Repeated so the exponential smoothing has somewhere to settle.
    for (let i = 0; i < 40; i++) {
      engine.pushPacket(packet({ samples, timestamp: i * 0.04 }))
    }

    const levels = await new Promise<readonly number[]>((resolve) => {
      const unsubscribe = engine.subscribeChannelLevels((l) => {
        unsubscribe()
        resolve([...l])
      })
      engine.setDashboardActive(true)
      engine.start()
    })

    expect(levels[0]).toBeGreaterThan(levels[1])
    expect(levels[0]).toBeLessThanOrEqual(1)
    expect(levels[1]).toBeGreaterThanOrEqual(0)
  })

  it("resizes the level array when the montage changes", async () => {
    engine.configure(config({ channelNames: ["C3", "Cz", "C4"] }))
    engine.pushPacket(
      packet({ samples: [[1], [2], [3]], channelNames: ["C3", "Cz", "C4"] })
    )

    const levels = await new Promise<readonly number[]>((resolve) => {
      const unsubscribe = engine.subscribeChannelLevels((l) => {
        unsubscribe()
        resolve([...l])
      })
      engine.setDashboardActive(true)
      engine.start()
    })

    expect(levels).toHaveLength(3)
  })
})

describe("configure", () => {
  it("adopts the montage the stream reports rather than assuming one", () => {
    // The dashboard must lay itself out from the STARTED frame; hardcoding the
    // montage would silently mis-map a differently ordered recording.
    engine.configure(config({ channelNames: ["C3", "Cz", "C4"], sampleRate: 500 }))

    expect(() =>
      engine.pushPacket(
        packet({ samples: [[1], [2], [3]], channelNames: ["C3", "Cz", "C4"] })
      )
    ).not.toThrow()
  })

  it("falls back to the default montage when the config omits one", () => {
    engine.configure(config({ channelNames: [] }))
    expect(() => engine.pushPacket(packet())).not.toThrow()
  })

  it("survives a montage with none of the waveform channels", () => {
    // Every trace the waveform card draws is absent here; it should render
    // nothing rather than index into an empty buffer.
    engine.configure(config({ channelNames: ["Fz", "Pz"] }))
    expect(() =>
      engine.pushPacket(packet({ samples: [[1], [2]], channelNames: ["Fz", "Pz"] }))
    ).not.toThrow()
  })
})

describe("robustness", () => {
  it("ignores a packet with no samples", () => {
    engine.configure(config())
    expect(() => engine.pushPacket(packet({ samples: [] }))).not.toThrow()
  })

  it("tolerates a topographic map missing an electrode", () => {
    engine.configure(config())
    expect(() =>
      engine.pushPacket(packet({ epochIndex: 1, topographic: { C3: -2.1 } }))
    ).not.toThrow()
  })

  it("tolerates an empty PSD", () => {
    engine.configure(config())
    expect(() =>
      engine.pushPacket(packet({ epochIndex: 1, psd: { freqs: [], power: [] } }))
    ).not.toThrow()
  })

  it("stops cleanly when it was never started", () => {
    expect(() => engine.stop()).not.toThrow()
  })

  it("start is idempotent", () => {
    engine.start()
    expect(() => engine.start()).not.toThrow()
  })
})

describe("waveform channel selection", () => {
  it("targets the sensorimotor strip, not the first eight in montage order", () => {
    // The stream carries 22 channels and the card is laid out for eight. Taking
    // the first eight would show a mostly frontal montage, where Mu ERD during
    // hand imagery does not appear.
    expect([...WAVE_CHANNELS]).toEqual(["FC3", "C5", "C3", "C1", "Cz", "C2", "C4", "C6"])
    for (const name of WAVE_CHANNELS) {
      expect(CHAN).toContain(name)
    }
  })
})
