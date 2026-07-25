"use client"

import { useEffect, useRef } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { ClassificationStatusBar } from "@/components/bci/dashboard/ClassificationStatusBar"
import { MetricCards } from "@/components/bci/dashboard/MetricCards"
import { SessionSidebar } from "@/components/bci/dashboard/SessionSidebar"
import { useBciEngineInstance } from "@/contexts/BciEngineContext"
import { useBciSession } from "@/contexts/BciSessionContext"
import { useEegStream } from "@/hooks/useEegStream"
import { useRequireAuth } from "@/hooks/useRequireAuth"

export function DashboardScreen() {
  const router = useRouter()
  const engine = useBciEngineInstance()
  const authStatus = useRequireAuth()
  const { activeSession, bandpassLo, bandpassHi, notchOn } = useBciSession()

  const stream = useEegStream({
    // Packets land ~25x a second, so they go straight to the canvas engine.
    // Routing them through React state would re-render the whole dashboard at
    // 25 Hz to redraw canvases React does not own.
    onPacket: (packet) => engine.pushPacket(packet),
    onConfig: (config) => engine.configure(config),
  })

  useEffect(() => {
    engine.setDashboardActive(true)
    return () => engine.setDashboardActive(false)
  }, [engine])

  // Reaching the dashboard without a reserved session means a direct URL hit or
  // a reload, both of which have nothing to stream.
  useEffect(() => {
    if (authStatus === "authenticated" && !activeSession) {
      router.replace("/session-init")
    }
  }, [authStatus, activeSession, router])

  /**
   * Open the socket exactly once per session.
   *
   * The server rejects a second INIT for a session that has left `pending`, so
   * a duplicate connect does not merely waste a socket — it reports an error on
   * a stream that is working. Two things conspire to cause one:
   *
   * Strict Mode mounts, cleans up, then remounts. Connecting straight from the
   * effect body would fire INIT, have the cleanup close that socket, and fire a
   * second INIT against a session already flipped to `active`. Deferring by a
   * tick lets the cleanup cancel the first attempt outright, so only the real
   * mount connects — the same reason SessionInitScreen defers its autostart.
   *
   * The id guard then covers re-runs for a session already streaming.
   */
  const startedRef = useRef<string | null>(null)
  useEffect(() => {
    if (authStatus !== "authenticated" || !activeSession) return

    let cancelled = false
    const id = setTimeout(() => {
      if (cancelled || startedRef.current === activeSession.sessionId) return
      startedRef.current = activeSession.sessionId

      engine.resetStream()
      stream.connect({
        sessionId: activeSession.sessionId,
        mode: activeSession.mode,
        datasetId: activeSession.datasetId,
        hardwareWsUrl: activeSession.hardwareWsUrl,
        notch: notchOn,
        bandpassLow: bandpassLo,
        bandpassHigh: bandpassHi,
      })
    }, 0)

    return () => {
      cancelled = true
      clearTimeout(id)
    }
    // The filter values are the session's starting point, read once here.
    // Re-running on every keystroke would restart the recording.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, activeSession, engine])

  if (authStatus === "loading" || !activeSession) {
    return (
      <div className="mx-auto flex min-h-[60vh] w-full max-w-6xl items-center justify-center px-4">
        <div className="size-12 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 pt-4 sm:px-6">
      <div className="flex flex-wrap items-start gap-4">
        <SessionSidebar stream={stream} />

        <div className="flex min-w-[300px] flex-1 flex-col gap-4">
          <MetricCards />
          <ClassificationStatusBar />
          <div className="flex flex-wrap gap-2.5">
            <Button variant="outline" nativeButton={false} render={<Link href="/dashboard/history" />}>
              Session History
            </Button>
            <Button variant="outline" nativeButton={false} render={<Link href="/dashboard/settings" />}>
              Settings
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
