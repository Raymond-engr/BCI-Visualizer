"use client"

import { useEffect, useRef } from "react"

import { useBciEngineInstance } from "@/contexts/BciEngineContext"

export function ClassificationStatusBar() {
  const engine = useBciEngineInstance()
  const badgeRef = useRef<HTMLDivElement>(null)
  const dotRef = useRef<HTMLSpanElement>(null)
  const labelRef = useRef<HTMLSpanElement>(null)
  const pctRef = useRef<HTMLSpanElement>(null)
  const confBarRef = useRef<HTMLDivElement>(null)
  const epochRef = useRef<HTMLSpanElement>(null)
  const tsRef = useRef<HTMLSpanElement>(null)

  useEffect(
    () =>
      engine.subscribeTelemetry((t) => {
        if (badgeRef.current) {
          badgeRef.current.style.borderColor = t.miColor
          badgeRef.current.style.background = `${t.miColor}1a`
        }
        if (dotRef.current) dotRef.current.style.background = t.miColor
        if (labelRef.current) {
          labelRef.current.textContent = t.miLabel
          labelRef.current.style.color = t.miColor
        }
        if (pctRef.current) {
          pctRef.current.textContent = `${t.confidencePct.toFixed(1)}%`
          pctRef.current.style.color = t.miColor
        }
        if (confBarRef.current) {
          confBarRef.current.style.width = `${t.confidencePct.toFixed(0)}%`
          confBarRef.current.style.background = `linear-gradient(90deg,${t.miColor},#37E29A)`
        }
        if (epochRef.current) epochRef.current.textContent = `#${t.epoch}`
        if (tsRef.current) tsRef.current.textContent = t.timestamp
      }),
    [engine]
  )

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card/70 px-4.5 py-3.5 backdrop-blur-md">
      <div
        ref={badgeRef}
        className="inline-flex items-center gap-3 rounded-full border px-4.5 py-2.5"
        style={{ borderColor: "#34D6F5", background: "rgba(52,214,245,.1)" }}
      >
        <span
          ref={dotRef}
          className="animate-pulse-dot size-[9px] rounded-full"
          style={{ background: "#34D6F5" }}
        />
        <span
          ref={labelRef}
          className="font-mono text-base font-semibold tracking-[0.06em]"
          style={{ color: "#34D6F5" }}
        >
          LEFT HAND
        </span>
        <span ref={pctRef} className="font-mono text-[13px] opacity-75" style={{ color: "#34D6F5" }}>
          79.2%
        </span>
      </div>

      <div className="min-w-[140px] max-w-[280px] flex-1">
        <div className="h-1.5 overflow-hidden rounded-full bg-border">
          <div
            ref={confBarRef}
            className="h-full rounded-full transition-[width]"
            style={{ width: "79%", background: "linear-gradient(90deg,#34D6F5,#37E29A)" }}
          />
        </div>
      </div>

      <div className="flex gap-4">
        <span className="font-mono text-[11px] text-muted-foreground">
          Epoch <span ref={epochRef}>#143</span>
        </span>
        <span ref={tsRef} className="font-mono text-[11px] text-muted-foreground">
          14:22:08
        </span>
      </div>
    </div>
  )
}
