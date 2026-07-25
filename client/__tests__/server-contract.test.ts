import fs from "fs"
import path from "path"

import { CHAN, EPOS, MI } from "@/lib/bci/constants"
import { toSessionMode, toSessionSource, type SessionMode } from "@/lib/api/types"

/**
 * Drift guards against the real backend source.
 *
 * The client and server agree on a montage, a label order and a set of mode
 * names by convention, not by a shared package. Every one of these is a
 * positional or string contract that fails silently when it breaks — a
 * reordered montage permutes the CSP filters, a reordered label list mislabels
 * every prediction, a renamed mode is rejected at INIT. These read the server's
 * own source so a change there fails here rather than in production.
 */

const SERVER = path.join(__dirname, "..", "..", "server", "src")

function readServer(relative: string): string {
  const file = path.join(SERVER, relative)
  if (!fs.existsSync(file)) {
    throw new Error(`Expected server source at ${file}`)
  }
  return fs.readFileSync(file, "utf8")
}

function extractBlock(source: string, startPattern: RegExp): string {
  const match = startPattern.exec(source)
  if (!match) {
    throw new Error(`Could not locate ${startPattern} in the server source`)
  }
  const from = match.index + match[0].length
  const end = source.indexOf("};", from)
  return source.slice(from, end === -1 ? undefined : end)
}

describe("montage", () => {
  const montageSource = readServer(path.join("utils", "montage.ts"))

  /** channelOrder is Object.keys(bciciv2aMontage), so the keys are the order. */
  const serverChannels = Array.from(
    extractBlock(montageSource, /export const bciciv2aMontage: Montage = \{/).matchAll(
      /^\s{2}([A-Za-z0-9]+):\s*\{/gm
    )
  ).map((m) => m[1])

  it("finds the server's montage", () => {
    expect(serverChannels.length).toBeGreaterThan(0)
  })

  it("matches the server's channel order exactly", () => {
    // Feature extraction indexes into the epoch by position, so this ordering
    // is the contract between the parser and the exported CSP filters.
    expect([...CHAN]).toEqual(serverChannels)
  })

  it("has a scalp position for every channel the server streams", () => {
    // The topographic map interpolates over EPOS; a channel the server sends
    // but EPOS lacks would silently vanish from the heatmap.
    for (const channel of serverChannels) {
      expect(Object.keys(EPOS)).toContain(channel)
    }
  })

  it("plots no electrode the server does not send", () => {
    for (const channel of Object.keys(EPOS)) {
      expect(serverChannels).toContain(channel)
    }
  })
})

describe("class labels", () => {
  const streamingSource = readServer(path.join("config", "streaming.ts"))
  const labelsMatch = /labels:\s*\[([^\]]+)\]/.exec(streamingSource)
  const serverLabels = (labelsMatch?.[1] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/['"]/g, ""))
    .filter(Boolean)

  it("finds the server's label list", () => {
    expect(serverLabels.length).toBeGreaterThan(0)
  })

  it("matches the server's classifier labels, in order", () => {
    // The ONNX graph emits probabilities positionally against this list.
    expect([...MI]).toEqual(serverLabels)
  })

  it("does not decode tongue", () => {
    // Dataset 2a records a fourth cue (772) and the parser reads it, but
    // nothing is trained to predict it. Excluding it keeps chance at 33.3%.
    expect(MI).not.toContain("tongue")
  })
})

describe("session modes", () => {
  const sessionSource = readServer(path.join("Sessions", "models", "session.model.ts"))
  // Bounded to the first closing brace: SessionStatus follows immediately, and
  // scanning past it would pull in pending/active/completed/error.
  const modeEnum = /export enum SessionMode \{([^}]+)\}/.exec(sessionSource)
  const serverModes = Array.from((modeEnum?.[1] ?? "").matchAll(/=\s*'([^']+)'/g)).map(
    (m) => m[1]
  )

  it("finds the server's mode enum", () => {
    expect(serverModes.length).toBeGreaterThan(0)
  })

  it("maps every UI source onto a mode the server accepts", () => {
    // The UI calls them sim/hw; the API persists simulation/hardware. A mode
    // the server does not know is rejected at INIT.
    const mapped: SessionMode[] = (["upload", "sim", "hw"] as const).map(toSessionMode)

    expect(mapped.sort()).toEqual([...serverModes].sort())
  })

  it("round-trips every mode back to its UI source", () => {
    for (const mode of serverModes as SessionMode[]) {
      expect(toSessionMode(toSessionSource(mode))).toBe(mode)
    }
  })
})

describe("sample rate and epoch window", () => {
  const streamingSource = readServer(path.join("config", "streaming.ts"))

  it("derives the epoch window from the sample rate", () => {
    // The client renders a 4-second waveform window to match the epoch. If the
    // server ever stops using a 4 s epoch, that alignment is a lie.
    expect(streamingSource).toMatch(/epochSamples:\s*SAMPLE_RATE\s*\*\s*4/)
  })

  it("still truncates the spectrum at the 40 Hz the PSD panel plots", () => {
    const features = readServer(
      path.join("Signal_Processing", "services", "features.service.ts")
    )
    expect(features).toMatch(/const maxFreq = 40/)
  })
})
