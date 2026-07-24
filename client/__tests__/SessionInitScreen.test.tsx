import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SessionInitScreen } from "@/components/bci/screens/SessionInitScreen"
import { uploadDataset } from "@/lib/api/datasets"
import { createSession } from "@/lib/api/sessions"

const push = jest.fn()
let searchParams = new URLSearchParams()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
  useSearchParams: () => searchParams,
}))

jest.mock("@/hooks/useRequireAuth", () => ({
  useRequireAuth: () => "authenticated",
}))

type SessionSource = "sim" | "upload" | "hw"

// Annotated rather than inferred: setSrc writes back into the object it is
// declared in, which TypeScript cannot resolve from the initializer alone.
type SessionStateStub = {
  src: SessionSource
  setSrc: jest.Mock
  setDatasetLabel: jest.Mock
  setActiveSession: jest.Mock
}

const sessionState: SessionStateStub = {
  src: "sim",
  setSrc: jest.fn((next: SessionSource) => (sessionState.src = next)),
  setDatasetLabel: jest.fn(),
  setActiveSession: jest.fn(),
}

jest.mock("@/contexts/BciSessionContext", () => ({
  useBciSession: () => sessionState,
}))

jest.mock("@/lib/api/sessions")
jest.mock("@/lib/api/datasets")

const mockedCreate = createSession as jest.MockedFunction<typeof createSession>
const mockedUpload = uploadDataset as jest.MockedFunction<typeof uploadDataset>

beforeEach(() => {
  jest.clearAllMocks()
  searchParams = new URLSearchParams()
  sessionState.src = "sim"
  mockedCreate.mockResolvedValue({ _id: "s1" } as any)
  mockedUpload.mockResolvedValue({ _id: "d1", originalName: "A01T.gdf" } as any)
})

describe("simulation", () => {
  it("reserves the session over REST, then hands it to the dashboard", async () => {
    // Creating the record first means an aborted socket still leaves a session
    // the user can see rather than a silent no-op.
    const user = userEvent.setup()
    render(<SessionInitScreen />)

    await user.click(screen.getByRole("button", { name: /Launch Session/ }))

    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"))
    expect(mockedCreate).toHaveBeenCalledWith({ mode: "simulation", datasetId: undefined })
    expect(sessionState.setActiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", mode: "simulation" })
    )
  })

  it("translates the UI's source name into the mode the API persists", async () => {
    const user = userEvent.setup()
    render(<SessionInitScreen />)

    await user.click(screen.getByRole("button", { name: /Launch Session/ }))

    await waitFor(() => expect(mockedCreate).toHaveBeenCalled())
    // "sim" is UI vocabulary; the server's enum says "simulation".
    expect(mockedCreate.mock.calls[0][0].mode).toBe("simulation")
  })
})

describe("dataset upload", () => {
  beforeEach(() => {
    sessionState.src = "upload"
  })

  it("refuses to start without a recording", async () => {
    const user = userEvent.setup()
    render(<SessionInitScreen />)

    await user.click(screen.getByRole("button", { name: /Launch Session/ }))

    expect(await screen.findByRole("alert")).toHaveTextContent(/Choose a .gdf or .csv/i)
    expect(mockedUpload).not.toHaveBeenCalled()
    expect(mockedCreate).not.toHaveBeenCalled()
  })

  it("uploads the recording, then builds the session on it", async () => {
    const user = userEvent.setup()
    render(<SessionInitScreen />)

    const file = new File(["x"], "A01T.gdf")
    await user.upload(screen.getByLabelText(/RECORDING/i), file)
    await user.click(screen.getByRole("button", { name: /Launch Session/ }))

    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"))
    expect(mockedUpload).toHaveBeenCalledWith(file)
    expect(mockedCreate).toHaveBeenCalledWith({ mode: "upload", datasetId: "d1" })
  })

  it("names the session after the uploaded file", async () => {
    const user = userEvent.setup()
    render(<SessionInitScreen />)

    await user.upload(screen.getByLabelText(/RECORDING/i), new File(["x"], "A01T.gdf"))
    await user.click(screen.getByRole("button", { name: /Launch Session/ }))

    await waitFor(() =>
      expect(sessionState.setDatasetLabel).toHaveBeenCalledWith("A01T.gdf")
    )
  })

  it("reports an unparseable recording and stays put", async () => {
    // The server parses synchronously and rejects a bad file with a 400, so the
    // user learns immediately rather than on the first epoch.
    mockedUpload.mockRejectedValue(
      new Error("Recording could not be read: File is truncated")
    )
    const user = userEvent.setup()
    render(<SessionInitScreen />)

    await user.upload(screen.getByLabelText(/RECORDING/i), new File(["x"], "bad.gdf"))
    await user.click(screen.getByRole("button", { name: /Launch Session/ }))

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be read/i)
    expect(push).not.toHaveBeenCalled()
    expect(mockedCreate).not.toHaveBeenCalled()
  })
})

describe("hardware", () => {
  beforeEach(() => {
    sessionState.src = "hw"
  })

  it("refuses to start without a bridge URL", async () => {
    const user = userEvent.setup()
    render(<SessionInitScreen />)

    await user.click(screen.getByRole("button", { name: /Launch Session/ }))

    expect(await screen.findByRole("alert")).toHaveTextContent(/WebSocket URL/i)
    expect(mockedCreate).not.toHaveBeenCalled()
  })

  it("carries the bridge URL through to the stream", async () => {
    // The server consumes frames from a local bridge; it cannot reach serial or
    // Bluetooth itself.
    const user = userEvent.setup()
    render(<SessionInitScreen />)

    await user.type(screen.getByLabelText(/BRIDGE/i), "ws://localhost:8080")
    await user.click(screen.getByRole("button", { name: /Launch Session/ }))

    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"))
    expect(sessionState.setActiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "hardware", hardwareWsUrl: "ws://localhost:8080" })
    )
  })

  it("rejects a whitespace-only URL", async () => {
    const user = userEvent.setup()
    render(<SessionInitScreen />)

    await user.type(screen.getByLabelText(/BRIDGE/i), "   ")
    await user.click(screen.getByRole("button", { name: /Launch Session/ }))

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(mockedCreate).not.toHaveBeenCalled()
  })
})

describe("autostart", () => {
  it("launches simulation straight from the landing page link", async () => {
    searchParams = new URLSearchParams("source=sim&autostart=1")
    render(<SessionInitScreen />)

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith({
      mode: "simulation",
      datasetId: undefined,
    }))
  })

  it("does not autostart upload, which has no file to work with", async () => {
    searchParams = new URLSearchParams("source=upload&autostart=1")
    render(<SessionInitScreen />)

    await waitFor(() => expect(screen.getByRole("button", { name: /Launch Session/ })).toBeInTheDocument())
    expect(mockedCreate).not.toHaveBeenCalled()
  })

  it("launches exactly once despite Strict Mode's double mount", async () => {
    // The server rejects a second session start, so a duplicate launch would
    // surface an error on a session that was fine.
    searchParams = new URLSearchParams("source=sim&autostart=1")
    const { StrictMode } = await import("react")

    render(
      <StrictMode>
        <SessionInitScreen />
      </StrictMode>
    )

    await waitFor(() => expect(mockedCreate).toHaveBeenCalled())
    expect(mockedCreate).toHaveBeenCalledTimes(1)
  })
})
