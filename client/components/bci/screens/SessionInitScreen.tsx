"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useBciSession } from "@/contexts/BciSessionContext"
import { useRequireAuth } from "@/hooks/useRequireAuth"
import { uploadDataset } from "@/lib/api/datasets"
import { createSession } from "@/lib/api/sessions"
import { toSessionMode } from "@/lib/api/types"
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
  const authStatus = useRequireAuth()
  const { src, setSrc, setDatasetLabel, setActiveSession } = useBciSession()

  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [hardwareWsUrl, setHardwareWsUrl] = useState("")

  useEffect(() => {
    const requested = searchParams.get("source")
    if (requested === "upload" || requested === "sim" || requested === "hw") {
      setSrc(requested)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function launchSession(source: SessionSource) {
    setError(null)

    if (source === "upload" && !file) {
      setError("Choose a .gdf or .csv recording to analyse.")
      return
    }
    if (source === "hw" && !hardwareWsUrl.trim()) {
      setError("Enter the WebSocket URL of your headset bridge.")
      return
    }

    setConnecting(true)

    try {
      let datasetId: string | undefined

      if (source === "upload" && file) {
        // Parsed synchronously server-side, so this resolving means the
        // recording is usable and a session can be built on it.
        const dataset = await uploadDataset(file)
        datasetId = dataset._id
        setDatasetLabel(dataset.originalName)
      } else {
        setDatasetLabel(SOURCE_CONNECT_COPY[source].dataset)
      }

      const mode = toSessionMode(source)
      const session = await createSession({ mode, datasetId })

      setActiveSession({
        sessionId: session._id,
        mode,
        datasetId,
        hardwareWsUrl: source === "hw" ? hardwareWsUrl.trim() : undefined,
      })

      router.push("/dashboard")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the session")
      setConnecting(false)
    }
  }

  useEffect(() => {
    if (searchParams.get("autostart") !== "1") return
    if (authStatus !== "authenticated") return
    // Only simulation can start unattended. Upload needs a file and hardware
    // needs a bridge URL, neither of which a link can supply.
    if (searchParams.get("source") !== "sim") return

    // Defer out of the effect body so the initial setConnecting(true) doesn't
    // fire synchronously during commit. `cancelled` (rather than a ref that
    // outlives the effect) is what makes this safe under Strict Mode's
    // mount→cleanup→remount: the cleanup only cancels the timeout belonging to
    // *this* invocation, so the real mount still launches.
    let cancelled = false
    const id = setTimeout(() => {
      if (!cancelled) launchSession("sim")
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, authStatus])

  if (authStatus === "loading") {
    return (
      <div className="mx-auto flex min-h-[60vh] w-full max-w-[560px] items-center justify-center px-4">
        <div className="size-12 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
      </div>
    )
  }

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

      {src === "upload" && (
        <div className="mb-6 flex flex-col gap-1.5">
          <label
            htmlFor="dataset-file"
            className="font-mono text-[11px] tracking-[0.1em] text-muted-foreground"
          >
            RECORDING · GDF OR CSV
          </label>
          <Input
            id="dataset-file"
            type="file"
            accept=".gdf,.csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {file.name} · {(file.size / 1_000_000).toFixed(1)} MB
            </span>
          )}
        </div>
      )}

      {src === "hw" && (
        <div className="mb-6 flex flex-col gap-1.5">
          <label
            htmlFor="hardware-url"
            className="font-mono text-[11px] tracking-[0.1em] text-muted-foreground"
          >
            HEADSET BRIDGE · WEBSOCKET URL
          </label>
          <Input
            id="hardware-url"
            placeholder="ws://localhost:8080"
            value={hardwareWsUrl}
            onChange={(e) => setHardwareWsUrl(e.target.value)}
          />
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            Serial and Bluetooth are not reachable from the server, so a local
            bridge process owns the headset and republishes its frames here.
          </span>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
        >
          {error}
        </p>
      )}

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
