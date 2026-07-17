import Link from "next/link"

import { Button } from "@/components/ui/button"
import { CLASS_BREAKDOWN, MI_COLOR, SAMPLE_SESSIONS } from "@/lib/bci/constants"

export function SessionHistoryScreen() {
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
        <Button variant="outline">Export All</Button>
      </div>

      <div className="flex flex-col gap-2.5">
        {SAMPLE_SESSIONS.map((s) => (
          <div
            key={s.dataset + s.date}
            className="flex flex-wrap items-center gap-3.5 rounded-2xl border border-border bg-secondary/40 p-4"
          >
            <span
              className="flex size-10 shrink-0 items-center justify-center rounded-xl"
              style={{ background: `${s.iconColor}24` }}
            >
              <span
                className="size-3.5 rounded-[4px]"
                style={{ background: s.iconColor }}
              />
            </span>
            <div className="min-w-[150px] flex-1">
              <div className="font-heading text-[15px] font-semibold">{s.dataset}</div>
              <div className="font-mono text-[11px] text-muted-foreground">
                {s.date} · {s.duration}
              </div>
            </div>
            <span
              className={`rounded-lg px-3 py-1 font-mono text-[13px] font-semibold ${
                s.accent === "good"
                  ? "bg-primary/12 text-primary"
                  : "bg-[#F5B740]/14 text-[#F5B740]"
              }`}
            >
              {s.accuracy}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm">
                View
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="bg-primary/12 text-primary hover:bg-primary/20"
              >
                CSV
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 rounded-2xl border border-border bg-card/55 p-5">
        <div className="mb-4 font-mono text-[10px] tracking-[0.1em] text-muted-foreground">
          CLASS BREAKDOWN · LATEST SESSION
        </div>
        <div className="flex flex-col gap-3">
          {CLASS_BREAKDOWN.map((c) => (
            <div key={c.cls} className="flex items-center gap-3">
              <span
                className="w-20 font-mono text-xs"
                style={{ color: MI_COLOR[c.cls] }}
              >
                {c.label}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-border">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${c.pct}%`, background: MI_COLOR[c.cls] }}
                />
              </div>
              <span className="font-mono text-xs text-muted-foreground">{c.pct}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
