import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SignInScreen } from "@/components/bci/screens/SignInScreen"
import { SignUpScreen } from "@/components/bci/screens/SignUpScreen"

const push = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
}))

const login = jest.fn()
const register = jest.fn()

// The screens used to be <Link>s dressed as submit buttons. They now go through
// the real context, so the context is the seam worth faking — the wiring from
// the form to login/register is exactly what is under test.
jest.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: null,
    status: "unauthenticated",
    login,
    register,
    logout: jest.fn(),
  }),
}))

beforeEach(() => {
  jest.clearAllMocks()
  login.mockResolvedValue(undefined)
  register.mockResolvedValue(undefined)
})

describe("signing in", () => {
  it("submits the credentials the user typed", async () => {
    const user = userEvent.setup()
    render(<SignInScreen />)

    await user.type(screen.getByLabelText(/EMAIL/i), "ada@uniben.edu")
    await user.type(screen.getByLabelText(/PASSWORD/i), "password123")
    await user.click(screen.getByRole("button", { name: "Sign In" }))

    await waitFor(() => expect(login).toHaveBeenCalledWith("ada@uniben.edu", "password123"))
  })

  it("moves the user on once the session exists", async () => {
    const user = userEvent.setup()
    render(<SignInScreen />)

    await user.type(screen.getByLabelText(/EMAIL/i), "ada@uniben.edu")
    await user.type(screen.getByLabelText(/PASSWORD/i), "password123")
    await user.click(screen.getByRole("button", { name: "Sign In" }))

    await waitFor(() => expect(push).toHaveBeenCalledWith("/onboarding"))
  })

  it("shows the server's reason for rejecting the sign-in", async () => {
    // The server distinguishes an unknown email from a wrong password, and that
    // wording is the only thing telling the user which mistake they made.
    login.mockRejectedValue(new Error("Incorrect password"))
    const user = userEvent.setup()
    render(<SignInScreen />)

    await user.type(screen.getByLabelText(/EMAIL/i), "ada@uniben.edu")
    await user.type(screen.getByLabelText(/PASSWORD/i), "wrong-password")
    await user.click(screen.getByRole("button", { name: "Sign In" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect password")
  })

  it("stays on the form when sign-in fails", async () => {
    login.mockRejectedValue(new Error("Incorrect password"))
    const user = userEvent.setup()
    render(<SignInScreen />)

    await user.type(screen.getByLabelText(/EMAIL/i), "ada@uniben.edu")
    await user.type(screen.getByLabelText(/PASSWORD/i), "wrong-password")
    await user.click(screen.getByRole("button", { name: "Sign In" }))

    await screen.findByRole("alert")
    expect(push).not.toHaveBeenCalled()
  })

  it("lets the user retry after a rejected attempt", async () => {
    // Leaving the button disabled after a failure would strand someone who
    // simply mistyped their password.
    login.mockRejectedValue(new Error("Incorrect password"))
    const user = userEvent.setup()
    render(<SignInScreen />)

    await user.type(screen.getByLabelText(/EMAIL/i), "ada@uniben.edu")
    await user.type(screen.getByLabelText(/PASSWORD/i), "wrong-password")
    await user.click(screen.getByRole("button", { name: "Sign In" }))

    await screen.findByRole("alert")
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign In" })).toBeEnabled())
  })

  it("clears a stale error when the user tries again", async () => {
    login.mockRejectedValueOnce(new Error("Incorrect password"))
    const user = userEvent.setup()
    render(<SignInScreen />)

    await user.type(screen.getByLabelText(/EMAIL/i), "ada@uniben.edu")
    await user.type(screen.getByLabelText(/PASSWORD/i), "wrong-password")
    await user.click(screen.getByRole("button", { name: "Sign In" }))
    await screen.findByRole("alert")

    await user.type(screen.getByLabelText(/PASSWORD/i), "-correct")
    await user.click(screen.getByRole("button", { name: "Sign In" }))

    await waitFor(() => expect(push).toHaveBeenCalledWith("/onboarding"))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("blocks a second submit while the first is in flight", async () => {
    // A double-click would otherwise fire two logins and race two tokens.
    login.mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    render(<SignInScreen />)

    await user.type(screen.getByLabelText(/EMAIL/i), "ada@uniben.edu")
    await user.type(screen.getByLabelText(/PASSWORD/i), "password123")
    await user.click(screen.getByRole("button", { name: "Sign In" }))

    const pending = await screen.findByRole("button", { name: /Signing in/ })
    expect(pending).toBeDisabled()
    expect(login).toHaveBeenCalledTimes(1)
  })

  it("does not sign in merely by rendering", async () => {
    // The old screen navigated on click alone; nothing should reach the API
    // until the user actually submits.
    render(<SignInScreen />)

    expect(login).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })
})

describe("signing up", () => {
  async function fillSignUp(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/FULL NAME/i), "Ada Lovelace")
    await user.type(screen.getByLabelText(/EMAIL/i), "ada@uniben.edu")
    await user.type(screen.getByLabelText(/PASSWORD/i), "password123")
  }

  it("registers with the details the user typed", async () => {
    const user = userEvent.setup()
    render(<SignUpScreen />)

    await fillSignUp(user)
    await user.click(screen.getByRole("button", { name: "Create Account" }))

    await waitFor(() =>
      expect(register).toHaveBeenCalledWith({
        name: "Ada Lovelace",
        email: "ada@uniben.edu",
        password: "password123",
      })
    )
  })

  it("moves the new account straight on to onboarding", async () => {
    // Registering signs the account in, so there is no reason to bounce the
    // user through the sign-in form.
    const user = userEvent.setup()
    render(<SignUpScreen />)

    await fillSignUp(user)
    await user.click(screen.getByRole("button", { name: "Create Account" }))

    await waitFor(() => expect(push).toHaveBeenCalledWith("/onboarding"))
  })

  it("shows the server's reason for rejecting the account", async () => {
    // Only the server knows the email is taken, and the user cannot fix it
    // without being told.
    register.mockRejectedValue(new Error("Email already registered"))
    const user = userEvent.setup()
    render(<SignUpScreen />)

    await fillSignUp(user)
    await user.click(screen.getByRole("button", { name: "Create Account" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("Email already registered")
    expect(push).not.toHaveBeenCalled()
  })

  it("lets the user fix a rejected registration and resubmit", async () => {
    register.mockRejectedValue(new Error("Email already registered"))
    const user = userEvent.setup()
    render(<SignUpScreen />)

    await fillSignUp(user)
    await user.click(screen.getByRole("button", { name: "Create Account" }))

    await screen.findByRole("alert")
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create Account" })).toBeEnabled()
    )
  })

  it("blocks a second submit while the first is in flight", async () => {
    // Two registers would try to create the same account twice, and the second
    // fails on the first one's success.
    register.mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    render(<SignUpScreen />)

    await fillSignUp(user)
    await user.click(screen.getByRole("button", { name: "Create Account" }))

    const pending = await screen.findByRole("button", { name: /Creating account/ })
    expect(pending).toBeDisabled()
    expect(register).toHaveBeenCalledTimes(1)
  })
})
