"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { useRequireAuth } from "@/hooks/useRequireAuth"
import { exportSessionCSV, getSession, listSessions } from "@/lib/api/sessions"
import type { BreakdownRow, Session, SessionMode } from "@/lib/api/types"
import { MI, MI_COLOR, MI_TITLE } from "@/lib/bci/constants"

/** Card accent per source, matching the mode colours used across the app. */
const MODE_COLOR: Record<SessionMode, string> = {
  upload: "#34D6F5",
  simulation: "#9A6BF2",
  hardware: "#37E29A",
}

/** Above this, the accuracy badge reads as healthy rather than marginal. */
const GOOD_ACCURACY = 0.75

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  })
}

function formatDuration(seconds?: number): string {
  if (!seconds || seconds < 0) return "--:--"
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0")
  const ss = String(Math.floor(seconds % 60)).padStart(2, "0")
  return `${mm}:${ss}`
}

export function SessionHistoryScreen() {
  const authStatus = useRequireAuth()

  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [breakdown, setBreakdown] = useState<BreakdownRow[]>([])

  useEffect(() => {
    if (authStatus !== "authenticated") return
    let cancelled = false

    listSessions({ limit: 50 })
      .then((payload) => {
        if (cancelled) return
        setSessions(payload.sessions)
        setSelectedId(payload.sessions[0]?._id ?? null)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load sessions")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [authStatus])

  // The breakdown is aggregated per session, so it is fetched for whichever
  // session is selected rather than bundled into the list response.
  useEffect(() => {
    if (!selectedId) return
    let cancelled = false

    getSession(selectedId)
      .then((payload) => {
        if (!cancelled) setBreakdown(payload.breakdown)
      })
      .catch(() => {
        if (!cancelled) setBreakdown([])
      })

    return () => {
      cancelled = true
    }
  }, [selectedId])

  const exportAll = useCallback(async () => {
    setExporting(true)
    try {
      // No bulk endpoint exists, and inventing one would mean holding every
      // epoch of every session in memory to concatenate them.
      for (const session of sessions) {
        await exportSessionCSV(session._id, `session-${session._id}.csv`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed")
    } finally {
      setExporting(false)
    }
  }, [sessions])

  const selected = sessions.find((s) => s._id === selectedId) ?? null
  const isLatest = selectedId !== null && selectedId === sessions[0]?._id
  const totalEpochs = breakdown.reduce((sum, row) => sum + row.count, 0)

  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 pt-4 sm:px-6">
      <div className="mb-5.5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="mb-1.5 -ml-2 text-muted-foreground"
            nativeButton={false}
            render={<Link href="/dashboard" />}
          >
            ← Dashboard
          </Button>
          <h2 className="font-heading text-[28px] font-bold tracking-[-0.02em]">
            Session History
          </h2>
        </div>
        <Button variant="outline" onClick={exportAll} disabled={exporting || !sessions.length}>
          {exporting ? "Exporting…" : "Export All"}
        </Button>
      </div>

      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
        >
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex min-h-[30vh] items-center justify-center">
          <div className="size-10 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
        </div>
      ) : !sessions.length ? (
        <div className="rounded-2xl border border-border bg-secondary/40 p-8 text-center">
          <p className="mb-4 text-sm text-muted-foreground">
            No sessions recorded yet.
          </p>
          <Button nativeButton={false} render={<Link href="/session-init" />}>
            Start a session
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {sessions.map((s) => {
            const color = MODE_COLOR[s.mode]
            const good = s.accuracy != null && s.accuracy >= GOOD_ACCURACY
            return (
              <div
                key={s._id}
                className={`flex flex-wrap items-center gap-3.5 rounded-2xl border bg-secondary/40 p-4 ${
                  s._id === selectedId ? "border-primary/45" : "border-border"
                }`}
              >
                <span
                  className="flex size-10 shrink-0 items-center justify-center rounded-xl"
                  style={{ background: `${color}24` }}
                >
                  <span className="size-3.5 rounded-[4px]" style={{ background: color }} />
                </span>
                <div className="min-w-[150px] flex-1">
                  <div className="font-heading text-[15px] font-semibold">
                    {s.sourceLabel}
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {formatDate(s.startTime ?? s.createdAt)} ·{" "}
                    {formatDuration(s.durationSeconds)}
                  </div>
                </div>
                <span
                  className={`rounded-lg px-3 py-1 font-mono text-[13px] font-semibold ${
                    s.accuracy == null
                      ? "bg-muted text-muted-foreground"
                      : good
                        ? "bg-primary/12 text-primary"
                        : "bg-[#F5B740]/14 text-[#F5B740]"
                  }`}
                  // A live headset emits no cue events, so accuracy is not
                  // merely unmeasured — it can never exist for that session.
                  title={
                    s.hasGroundTruth
                      ? "Accuracy against the recording's cue events"
                      : "No cue events on a live headset, so accuracy is unavailable"
                  }
                >
                  {s.accuracy == null ? "—" : `${(s.accuracy * 100).toFixed(1)}%`}
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setSelectedId(s._id)}>
                    View
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="bg-primary/12 text-primary hover:bg-primary/20"
                    onClick={() =>
                      exportSessionCSV(s._id, `session-${s._id}.csv`).catch((err) =>
                        setError(err instanceof Error ? err.message : "Export failed")
                      )
                    }
                  >
                    CSV
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {selected && (
        <div className="mt-5 rounded-2xl border border-border bg-card/55 p-5">
          <div className="mb-4 font-mono text-[10px] tracking-[0.1em] text-muted-foreground">
            CLASS BREAKDOWN ·{" "}
            {isLatest ? "LATEST SESSION" : selected.sourceLabel.toUpperCase()}
          </div>
          {!totalEpochs ? (
            <p className="text-[13px] text-muted-foreground">
              No epochs were classified in this session.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {MI.map((cls) => {
                // Share of the session's epochs predicted as this class. The
                // server sorts by count; the fixed MI order keeps the bars from
                // reshuffling between sessions.
                const row = breakdown.find((b) => b._id === cls)
                const pct = row ? (row.count / totalEpochs) * 100 : 0
                return (
                  <div key={cls} className="flex items-center gap-3">
                    <span className="w-20 font-mono text-xs" style={{ color: MI_COLOR[cls] }}>
                      {MI_TITLE[cls]}
                    </span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-border">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct}%`, background: MI_COLOR[cls] }}
                      />
                    </div>
                    <span className="font-mono text-xs text-muted-foreground">
                      {pct.toFixed(0)}%
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
