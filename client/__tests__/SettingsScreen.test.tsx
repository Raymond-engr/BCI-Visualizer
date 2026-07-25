import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SettingsScreen } from "@/components/bci/screens/SettingsScreen"
import { getPreferenceOptions } from "@/lib/api/preferences"

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))

let authStatus = "authenticated"

jest.mock("@/hooks/useRequireAuth", () => ({
  useRequireAuth: () => authStatus,
}))

let sessionState: any

jest.mock("@/contexts/BciSessionContext", () => ({
  useBciSession: () => sessionState,
}))

jest.mock("@/lib/api/preferences")

const mockedOptions = getPreferenceOptions as jest.MockedFunction<typeof getPreferenceOptions>

/**
 * Deliberately not the 250 Hz / 4.0 s the constants file states, so an
 * assertion can tell a value that came from the server apart from one the
 * bundle happened to ship with.
 */
const OPTIONS = {
  sampleRate: 500,
  epochSeconds: 2.5,
  notchFreq: 50,
  bandpassOptions: [
    { low: 8, high: 30, label: "8–30 Hz · Mu + Beta" },
    { low: 8, high: 13, label: "8–13 Hz · Mu" },
    { low: 13, high: 30, label: "13–30 Hz · Beta" },
  ],
}

beforeEach(() => {
  jest.clearAllMocks()
  authStatus = "authenticated"
  mockedOptions.mockResolvedValue(OPTIONS)
  sessionState = {
    settingsCategory: "signal",
    setSettingsCategory: jest.fn(),
  }
})

describe("the epoch window", () => {
  it("reports the window the pipeline is actually running", async () => {
    // The window is derived server-side from SAMPLE_RATE. Restating it in the
    // client would go stale the moment the deployment retunes.
    render(<SettingsScreen />)

    expect(await screen.findByText("2.5 s")).toBeInTheDocument()
  })

  it("shows the built-in figure while the request is still in flight", () => {
    // A round trip must not leave the readout blank or showing a spinner where
    // a number belongs.
    mockedOptions.mockReturnValue(new Promise(() => {}))
    render(<SettingsScreen />)

    expect(screen.getByText("4.0 s")).toBeInTheDocument()
  })

  it("keeps the built-in figure when the request fails", async () => {
    // Settings is not the place to strand a user over a readout; the shipped
    // constant is the deployment's own default and is very likely right.
    mockedOptions.mockRejectedValue(new Error("Network request failed"))
    render(<SettingsScreen />)

    await waitFor(() => expect(mockedOptions).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByText("4.0 s")).toBeInTheDocument()
  })
})

describe("the sample rate", () => {
  beforeEach(() => {
    sessionState.settingsCategory = "hardware"
  })

  it("reports the rate the server is decoding at", async () => {
    render(<SettingsScreen />)

    expect(await screen.findByText("500 Hz")).toBeInTheDocument()
  })

  it("shows the built-in figure while the request is still in flight", () => {
    mockedOptions.mockReturnValue(new Promise(() => {}))
    render(<SettingsScreen />)

    expect(screen.getByText("250 Hz")).toBeInTheDocument()
  })
})

describe("the bandpass band", () => {
  it("offers no free-text band, because only precomputed ones exist", async () => {
    // The server holds coefficients for a fixed set of bands and rejects
    // anything else, so a field that invites an arbitrary band would mostly
    // produce errors.
    render(<SettingsScreen />)
    await screen.findByText("2.5 s")

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument()
    expect(screen.queryByRole("slider")).not.toBeInTheDocument()
  })
})

describe("categories", () => {
  it("opens on signal processing", () => {
    render(<SettingsScreen />)

    expect(screen.getByRole("button", { name: "Signal Processing" })).toBeInTheDocument()
    expect(screen.getByText("Epoch window")).toBeInTheDocument()
  })

  it("switches to the hardware settings when picked", async () => {
    const user = userEvent.setup()
    render(<SettingsScreen />)

    await user.click(screen.getByRole("button", { name: "Hardware" }))

    expect(sessionState.setSettingsCategory).toHaveBeenCalledWith("hardware")
  })

  it("shows each category its own rows", () => {
    sessionState.settingsCategory = "hardware"
    render(<SettingsScreen />)

    expect(screen.getByText("Sample rate")).toBeInTheDocument()
    expect(screen.queryByText("Epoch window")).not.toBeInTheDocument()
  })
})

describe("guards", () => {
  it("waits rather than asking while auth is still rehydrating", async () => {
    // Rehydration takes a round trip; asking before it lands would 401 and
    // drop the screen back to the shipped constants for no reason.
    authStatus = "loading"
    render(<SettingsScreen />)

    await new Promise((r) => setTimeout(r, 20))
    expect(mockedOptions).not.toHaveBeenCalled()
  })
})
