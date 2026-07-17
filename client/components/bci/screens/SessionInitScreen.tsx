"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"

import { Button } from "@/components/ui/button"
import { useBciSession } from "@/contexts/BciSessionContext"
import { SOURCE_CONNECT_COPY, SOURCE_LABEL, type SessionSource } from "@/lib/bci/constants"

const SOURCES: {
  key: SessionSource
  title: string
  desc: string
  badge?: string
  iconWrap: string
  icon: React.ReactNode
}[] = [
  {
    key: "upload",
    title: "Analyse Dataset",
    desc: "Upload GDF or CSV for high-fidelity offline analysis.",
    iconWrap: "bg-[#34D6F5]/14 text-[#34D6F5]",
    icon: <path d="M12 15V3m0 0l-4 4m4-4l4 4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />,
  },
  {
    key: "sim",
    title: "Run Simulation",
    desc: "Stream a pre-loaded BCI dataset in real time.",
    badge: "DEMO",
    iconWrap: "bg-[#9A6BF2]/16 text-[#9A6BF2]",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M10 8l6 4-6 4V8z" fill="currentColor" stroke="none" />
      </>
    ),
  },
  {
    key: "hw",
    title: "Connect Hardware",
    desc: "Live EEG from OpenBCI or a BLE headset.",
    iconWrap: "bg-primary/14 text-primary",
    icon: <path d="M5 13a10 10 0 0114 0M8.5 16.5a5 5 0 017 0M12 20h.01" />,
  },
]

export function SessionInitScreen() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { src, setSrc, setDatasetLabel } = useBciSession()
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    const requested = searchParams.get("source")
    if (requested === "upload" || requested === "sim" || requested === "hw") {
      setSrc(requested)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function launchSession(source: SessionSource) {
    setConnecting(true)
    // Simulated dummy connect call — real integration will swap this for
    // an actual upload/parse or hardware-pairing request.
    await new Promise((resolve) => setTimeout(resolve, 1100 + Math.random() * 500))
    setDatasetLabel(SOURCE_CONNECT_COPY[source].dataset)
    router.push("/dashboard")
  }

  useEffect(() => {
    if (searchParams.get("autostart") !== "1") return
    const requested = searchParams.get("source")
    const source: SessionSource =
      requested === "upload" || requested === "sim" || requested === "hw"
        ? requested
        : "sim"
    // Defer out of the effect body so the initial setConnecting(true)
    // doesn't fire synchronously during commit. `cancelled` (rather than a
    // ref that outlives the effect) is what makes this safe under Strict
    // Mode's mount→cleanup→remount: the cleanup only cancels the timeout
    // belonging to *this* invocation, so the real mount still launches.
    let cancelled = false
    const id = setTimeout(() => {
      if (!cancelled) launchSession(source)
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  if (connecting) {
    return (
      <div className="mx-auto flex min-h-[60vh] w-full max-w-[560px] flex-col items-center justify-center px-4 text-center sm:px-6">
        <div className="mb-6 size-12 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
        <p className="font-mono text-[13px] tracking-[0.06em] text-muted-foreground">
          {SOURCE_CONNECT_COPY[src].connecting}
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[560px] px-4 pb-20 pt-4 sm:px-6">
      <Button
        variant="ghost"
        size="sm"
        className="mb-5 -ml-2 text-muted-foreground"
        nativeButton={false}
        render={<Link href="/" />}
      >
        ← Back
      </Button>
      <span className="font-mono text-[11px] tracking-[0.1em] text-muted-foreground">
        INITIALIZE SESSION
      </span>
      <h2 className="mb-6 mt-1.5 font-heading text-[28px] font-bold tracking-[-0.02em]">
        Select input source
      </h2>

      <div className="mb-6 flex flex-col gap-3">
        {SOURCES.map((s) => {
          const active = src === s.key
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setSrc(s.key)}
              className={`flex items-center gap-3.5 rounded-2xl border p-4 text-left transition-all ${
                active
                  ? "border-primary/55 bg-primary/8"
                  : "border-border bg-secondary/40"
              }`}
            >
              <span
                className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${s.iconWrap}`}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {s.icon}
                </svg>
              </span>
              <span className="flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="font-heading text-base font-semibold">
                    {s.title}
                  </span>
                  {s.badge && (
                    <span className="rounded-md bg-[#F5B740]/16 px-1.5 py-0.5 font-mono text-[9px] tracking-[0.08em] text-[#F5B740]">
                      {s.badge}
                    </span>
                  )}
                </span>
                <span className="text-[13px] text-muted-foreground">{s.desc}</span>
              </span>
              <span
                className={`size-[18px] shrink-0 rounded-full border-2 ${
                  active ? "border-primary bg-primary" : "border-border bg-transparent"
                }`}
              />
            </button>
          )
        })}
      </div>

      <Button
        size="lg"
        className="h-auto w-full rounded-xl py-3.5 text-[15px] shadow-[0_8px_26px_rgba(55,226,154,.3)]"
        onClick={() => launchSession(src)}
      >
        Launch Session · {SOURCE_LABEL[src]} →
      </Button>
    </div>
  )
}
