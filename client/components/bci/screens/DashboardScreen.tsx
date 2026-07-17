"use client"

import { useEffect } from "react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { ClassificationStatusBar } from "@/components/bci/dashboard/ClassificationStatusBar"
import { MetricCards } from "@/components/bci/dashboard/MetricCards"
import { SessionSidebar } from "@/components/bci/dashboard/SessionSidebar"
import { useBciEngineInstance } from "@/contexts/BciEngineContext"

export function DashboardScreen() {
  const engine = useBciEngineInstance()

  useEffect(() => {
    engine.setDashboardActive(true)
    return () => engine.setDashboardActive(false)
  }, [engine])

  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 pt-4 sm:px-6">
      <div className="flex flex-wrap items-start gap-4">
        <SessionSidebar />

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
