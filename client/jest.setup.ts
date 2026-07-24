import "@testing-library/jest-dom"
import { configure } from "@testing-library/react"

// The API base the fetch wrapper resolves at import time. Set here so tests
// assert against a stable origin rather than whatever .env.local happens to say.
process.env.NEXT_PUBLIC_API_URL = "http://api.test/api/v1"
process.env.NEXT_PUBLIC_WS_URL = "ws://api.test/ws/stream"

// findBy*/waitFor default to 1s. Several screens settle behind a userEvent
// session plus a mocked round trip, which comfortably fits that budget alone
// but not when Jest's workers are competing for the CPU — the suite passed
// serially and failed intermittently in parallel. The extra headroom costs
// nothing on a passing assertion; only a genuine failure waits it out.
configure({ asyncUtilTimeout: 5000 })
