"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { useBciEngineInstance } from "@/contexts/BciEngineContext"
import { useBciSession } from "@/contexts/BciSessionContext"
import type { EegStream, StreamStatus } from "@/hooks/useEegStream"
import { updatePreferences } from "@/lib/api/preferences"
import { CHAN, SOURCE_LABEL } from "@/lib/bci/constants"

const STATUS_COPY: Record<StreamStatus, { label: string; color: string }> = {
  idle: { label: "IDLE", color: "#9db4a9" },
  connecting: { label: "CONNECTING", color: "#F5B740" },
  streaming: { label: "STREAMING", color: "#37E29A" },
  completed: { label: "COMPLETE", color: "#34D6F5" },
  error: { label: "ERROR", color: "#F58585" },
}

/** How long to wait after the last keystroke before retuning the stream. */
const FILTER_DEBOUNCE_MS = 700

export function SessionSidebar({ stream }: { stream: EegStream }) {
  const router = useRouter()
  const engine = useBciEngineInstance()
  const {
    src,
    bandpassLo,
    bandpassHi,
    setBandpass,
    notchOn,
    toggleNotch,
    setActiveSession,
  } = useBciSession()

  const timerRef = useRef<HTMLDivElement>(null)
  const barRefs = useRef<(HTMLDivElement | null)[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The stream reports the montage it is actually sending, so the channel list
  // follows the recording rather than a hardcoded assumption.
  const channels = stream.config?.channelNames ?? [...CHAN]
  const status = STATUS_COPY[stream.status]

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

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  /**
   * Retune the running stream and remember the choice.
   *
   * CONTROL rather than a reconnect: reopening the socket would restart the
   * recording from the top and lose the session's history. An unsupported band
   * is rejected by the server before any state changes, so the stream keeps
   * running on the previous filter and reports what is still in force.
   */
  function syncFilters(lo: number, hi: number, notch: boolean, debounce: boolean) {
    if (debounceRef.current) clearTimeout(debounceRef.current)

    const apply = () => {
      stream.sendControl({ bandpassLow: lo, bandpassHigh: hi, notch })
      // Rejected here for the same reason it would be rejected on the socket,
      // and the socket's reply is what the user sees, so stay quiet.
      updatePreferences({
        bandpassLow: lo,
        bandpassHigh: hi,
        notchEnabled: notch,
      }).catch(() => undefined)
    }

    if (debounce) debounceRef.current = setTimeout(apply, FILTER_DEBOUNCE_MS)
    else apply()
  }

  function onBandpassChange(lo: number, hi: number) {
    setBandpass(lo, hi)
    syncFilters(lo, hi, notchOn, true)
  }

  function onNotchToggle() {
    const next = !notchOn
    toggleNotch()
    syncFilters(bandpassLo, bandpassHi, next, false)
  }

  function stopSession() {
    stream.disconnect()
    setActiveSession(null)
    engine.resetStream()
    router.push("/")
  }

  return (
    <aside className="flex w-full max-w-[300px] shrink-0 flex-col gap-4 rounded-2xl border border-border bg-card/60 p-4.5 backdrop-blur-md">
      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-2">
          <span
            className="animate-pulse-dot size-2 rounded-full"
            style={{ background: status.color }}
          />
          <span
            className="font-mono text-[11px] tracking-[0.1em]"
            style={{ color: status.color }}
          >
            {status.label}
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
          CHANNELS · {channels.length}
        </div>
        <div className="flex max-h-[180px] flex-col gap-1.5 overflow-auto">
          {channels.map((name, i) => (
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
                  style={{ width: "18%" }}
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
            onChange={(e) => onBandpassChange(Number(e.target.value) || 0, bandpassHi)}
            className="text-center font-mono text-[13px]"
          />
          <span className="text-xs text-muted-foreground">–</span>
          <Input
            value={bandpassHi}
            onChange={(e) => onBandpassChange(bandpassLo, Number(e.target.value) || 0)}
            className="text-center font-mono text-[13px]"
          />
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">Hz</span>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[13px] text-muted-foreground">50 Hz Notch</span>
          <Switch checked={notchOn} onCheckedChange={onNotchToggle} />
        </div>

        {stream.error && (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive"
          >
            {stream.error}
          </p>
        )}
      </div>

      <Button
        variant="outline"
        className="mt-auto border-[#F58585]/40 bg-[#F58585]/8 text-[#F58585] hover:bg-[#F58585]/15"
        onClick={stopSession}
      >
        ■ Stop Session
      </Button>
    </aside>
  )
}
