"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { useBciEngineInstance } from "@/contexts/BciEngineContext"
import { useBciSession } from "@/contexts/BciSessionContext"
import { CHAN, SOURCE_LABEL } from "@/lib/bci/constants"

export function SessionSidebar() {
  const router = useRouter()
  const engine = useBciEngineInstance()
  const { src, bandpassLo, bandpassHi, setBandpass, notchOn, toggleNotch } = useBciSession()

  const timerRef = useRef<HTMLDivElement>(null)
  const barRefs = useRef<(HTMLDivElement | null)[]>([])

  useEffect(
    () =>
      engine.subscribeTelemetry((t) => {
        if (timerRef.current) timerRef.current.textContent = t.sessionTime
      }),
    [engine]
  )

  useEffect(
    () =>
      engine.subscribeChannelLevels((levels) => {
        levels.forEach((lvl, i) => {
          const el = barRefs.current[i]
          if (el) el.style.width = `${18 + lvl * 80}%`
        })
      }),
    [engine]
  )

  return (
    <aside className="flex w-full max-w-[300px] shrink-0 flex-col gap-4 rounded-2xl border border-border bg-card/60 p-4.5 backdrop-blur-md">
      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-2">
          <span className="animate-pulse-dot size-2 rounded-full bg-primary" />
          <span className="font-mono text-[11px] tracking-[0.1em] text-primary">
            STREAMING
          </span>
        </div>
        <span className="rounded-md border border-[#9A6BF2]/30 px-2 py-0.5 font-mono text-[10px] text-[#9A6BF2]">
          {SOURCE_LABEL[src]}
        </span>
      </div>

      <div>
        <div className="mb-0.5 font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
          SESSION TIME
        </div>
        <div ref={timerRef} className="font-mono text-[26px] font-semibold text-primary">
          00:00:00
        </div>
      </div>

      <div className="h-px bg-border" />

      <div>
        <div className="mb-2.5 font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
          CHANNELS · {CHAN.length}
        </div>
        <div className="flex max-h-[180px] flex-col gap-1.5 overflow-auto">
          {CHAN.map((name, i) => (
            <div key={name} className="flex items-center gap-2.5">
              <span className="w-[34px] shrink-0 font-mono text-[11px] text-muted-foreground">
                {name}
              </span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-border">
                <div
                  ref={(el) => {
                    barRefs.current[i] = el
                  }}
                  className="h-full rounded-full bg-gradient-to-r from-[#14A06B] to-primary transition-[width] duration-100"
                  style={{ width: "30%" }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="h-px bg-border" />

      <div>
        <div className="mb-2.5 font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
          BANDPASS FILTER
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={bandpassLo}
            onChange={(e) => setBandpass(Number(e.target.value) || 0, bandpassHi)}
            className="text-center font-mono text-[13px]"
          />
          <span className="text-xs text-muted-foreground">–</span>
          <Input
            value={bandpassHi}
            onChange={(e) => setBandpass(bandpassLo, Number(e.target.value) || 0)}
            className="text-center font-mono text-[13px]"
          />
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">Hz</span>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[13px] text-muted-foreground">50 Hz Notch</span>
          <Switch checked={notchOn} onCheckedChange={toggleNotch} />
        </div>
      </div>

      <Button
        variant="outline"
        className="mt-auto border-[#F58585]/40 bg-[#F58585]/8 text-[#F58585] hover:bg-[#F58585]/15"
        onClick={() => router.push("/")}
      >
        ■ Stop Session
      </Button>
    </aside>
  )
}
