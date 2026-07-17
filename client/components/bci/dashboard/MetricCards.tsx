"use client"

import { useEffect, useRef } from "react"

import { DashboardBrainCanvas } from "@/components/bci/charts/DashboardBrainCanvas"
import { PSDChart } from "@/components/bci/charts/PSDChart"
import { TopoMapChart } from "@/components/bci/charts/TopoMapChart"
import { WaveformChart } from "@/components/bci/charts/WaveformChart"
import { useBciEngineInstance } from "@/contexts/BciEngineContext"

function MiPanelBadge() {
  const engine = useBciEngineInstance()
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(
    () =>
      engine.subscribeTelemetry((t) => {
        const el = ref.current
        if (!el) return
        el.textContent = t.miLabel
        el.style.color = t.miColor
        el.style.background = `${t.miColor}1f`
      }),
    [engine]
  )

  return (
    <span
      ref={ref}
      className="rounded-md px-2 py-0.5 font-mono text-[10px]"
      style={{ color: "#34D6F5", background: "rgba(52,214,245,.12)" }}
    >
      LEFT HAND
    </span>
  )
}

function CardShell({
  label,
  accent,
  right,
  children,
}: {
  label: string
  accent: string
  right: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div
      className="rounded-2xl border border-border bg-card/60 p-4 backdrop-blur-md"
      style={{ borderTop: `3px solid ${accent}` }}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] tracking-[0.1em] text-muted-foreground">
          {label}
        </span>
        {right}
      </div>
      {children}
    </div>
  )
}

export function MetricCards() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <CardShell
        label="EEG CHANNELS"
        accent="#34D6F5"
        right={
          <span className="rounded-md bg-[#34D6F5]/12 px-2 py-0.5 font-mono text-[10px] text-[#34D6F5]">
            8 traces
          </span>
        }
      >
        <WaveformChart />
      </CardShell>

      <CardShell label="MOTOR IMAGERY" accent="#37E29A" right={<MiPanelBadge />}>
        <DashboardBrainCanvas />
      </CardShell>

      <CardShell
        label="POWER SPECTRUM"
        accent="#9A6BF2"
        right={
          <div className="flex gap-2.5">
            <span className="font-mono text-[9px] text-[#34D6F5]">μ Mu</span>
            <span className="font-mono text-[9px] text-[#9A6BF2]">β Beta</span>
          </div>
        }
      >
        <PSDChart />
      </CardShell>

      <CardShell
        label="TOPO MAP"
        accent="#F5B740"
        right={
          <span className="font-mono text-[9px] text-muted-foreground">Mu Band</span>
        }
      >
        <TopoMapChart />
      </CardShell>
    </div>
  )
}
