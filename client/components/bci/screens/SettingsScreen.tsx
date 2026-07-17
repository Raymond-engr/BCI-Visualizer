"use client"

import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useBciSession } from "@/contexts/BciSessionContext"
import { SETTINGS_CATEGORIES, type SettingsCategory } from "@/lib/bci/constants"

const CATEGORIES: SettingsCategory[] = ["signal", "hardware"]

export function SettingsScreen() {
  const { settingsCategory, setSettingsCategory } = useBciSession()
  const cat = SETTINGS_CATEGORIES[settingsCategory]

  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 pt-4 sm:px-6">
      <Button
        variant="ghost"
        size="sm"
        className="mb-1.5 -ml-2 text-muted-foreground"
        nativeButton={false}
        render={<Link href="/dashboard" />}
      >
        ← Dashboard
      </Button>
      <h2 className="mb-5.5 font-heading text-[28px] font-bold tracking-[-0.02em]">
        Settings
      </h2>

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex w-full max-w-[240px] flex-col gap-1.5">
          {CATEGORIES.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setSettingsCategory(key)}
              className={`rounded-xl px-3.5 py-3 text-left text-sm font-semibold ${
                settingsCategory === key
                  ? "bg-primary/12 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {SETTINGS_CATEGORIES[key].title}
            </button>
          ))}
        </div>

        <div className="min-w-[280px] flex-[2] rounded-2xl border border-border bg-card/55 p-5.5">
          <div className="mb-4.5 font-heading text-lg font-semibold">{cat.title}</div>
          <div className="flex flex-col gap-4.5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold">{cat.rows[0].title}</div>
                <div className="text-xs text-muted-foreground">{cat.rows[0].desc}</div>
              </div>
              <Switch defaultChecked />
            </div>
            <div className="h-px bg-border" />
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold">{cat.rows[1].title}</div>
                <div className="text-xs text-muted-foreground">{cat.rows[1].desc}</div>
              </div>
              <Switch />
            </div>
            <div className="h-px bg-border" />
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold">{cat.rows[2].title}</div>
              </div>
              <span className="rounded-lg border border-primary/30 px-3 py-1.5 font-mono text-[13px] text-primary">
                {cat.rows[2].value}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
