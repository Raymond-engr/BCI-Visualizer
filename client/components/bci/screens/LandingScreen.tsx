import Link from "next/link"

import { Button } from "@/components/ui/button"
import { HeroBrainCanvas } from "@/components/bci/charts/HeroBrainCanvas"

const FEATURE_CARDS = [
  {
    href: "/session-init?source=upload",
    accent: "cyan" as const,
    title: "Analyse Dataset",
    desc: "Upload a GDF or CSV EEG recording for offline decoding.",
    icon: (
      <path d="M12 3v12m0-12l-4 4m4-4l4 4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
    ),
  },
  {
    href: "/session-init?source=sim&autostart=1",
    accent: "violet" as const,
    title: "Run Simulation",
    desc: "Stream a pre-loaded BCI dataset in real time — no hardware.",
    badge: "DEMO",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M10 8l6 4-6 4V8z" fill="currentColor" stroke="none" />
      </>
    ),
  },
  {
    href: "/session-init?source=hw",
    accent: "emerald" as const,
    title: "Connect Hardware",
    desc: "Stream live EEG from an OpenBCI or BLE headset.",
    icon: <path d="M5 13a10 10 0 0114 0M8.5 16.5a5 5 0 017 0M12 20h.01" />,
  },
]

const ACCENT_CLASSES = {
  cyan: {
    iconWrap: "bg-[#34D6F5]/14 text-[#34D6F5]",
    hover: "hover:border-[#34D6F5]/60 hover:shadow-[0_0_28px_rgba(52,214,245,.16)]",
  },
  violet: {
    iconWrap: "bg-[#9A6BF2]/16 text-[#9A6BF2]",
    hover: "hover:border-[#9A6BF2]/70 hover:shadow-[0_0_28px_rgba(154,107,242,.18)]",
  },
  emerald: {
    iconWrap: "bg-primary/14 text-primary",
    hover: "hover:border-primary/60 hover:shadow-[0_0_28px_rgba(55,226,154,.16)]",
  },
}

export function LandingScreen() {
  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 pt-4 sm:px-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-5">
          <span className="font-mono text-[11px] tracking-[0.06em] text-muted-foreground">
            Docs
          </span>
          <span className="font-mono text-[11px] tracking-[0.06em] text-muted-foreground">
            GitHub
          </span>
        </div>
        <div className="flex gap-2.5">
          <Button
            variant="outline"
            size="lg"
            nativeButton={false}
            render={<Link href="/sign-in" />}
          >
            Sign In
          </Button>
          <Button
            size="lg"
            className="shadow-[0_6px_20px_rgba(55,226,154,.28)]"
            nativeButton={false}
            render={<Link href="/sign-up" />}
          >
            Get Started
          </Button>
        </div>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-7 lg:mt-10 lg:flex-nowrap">
        <div className="min-w-[280px] flex-1">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-secondary/50 px-3 py-1.5">
            <span className="size-[7px] animate-pulse-dot rounded-full bg-primary" />
            <span className="font-mono text-[11px] tracking-[0.1em] text-muted-foreground">
              REAL-TIME MOTOR IMAGERY
            </span>
          </div>
          <h1 className="mb-4 font-heading text-[clamp(38px,6vw,62px)] leading-[0.98] font-bold tracking-[-0.03em]">
            Decode the
            <br />
            <span className="animate-shimmer bg-[linear-gradient(100deg,#37E29A,#34D6F5,#37E29A)] bg-[length:200%_auto] bg-clip-text text-transparent">
              mind in motion
            </span>
          </h1>
          <p className="mb-7 max-w-[460px] text-base leading-relaxed text-muted-foreground">
            Stream EEG brain signals, classify Motor Imagery tasks in real
            time, and watch thought render as living 3D. In your browser. No
            installation. Just signal.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              size="lg"
              className="h-auto rounded-xl px-6 py-3.5 text-[15px] shadow-[0_8px_26px_rgba(55,226,154,.32)]"
              nativeButton={false}
              render={<Link href="/session-init?source=sim&autostart=1" />}
            >
              Launch Live Demo →
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="h-auto rounded-xl px-6 py-3.5 text-[15px]"
              nativeButton={false}
              render={<Link href="/onboarding" />}
            >
              Set Up a Session
            </Button>
          </div>
        </div>

        <div className="relative min-w-[270px] flex-1">
          <div className="relative aspect-square overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-secondary/70 to-card/55 shadow-[0_30px_80px_rgba(0,0,0,.5)] backdrop-blur-xl">
            <HeroBrainCanvas />
            <div className="animate-float-y absolute left-4 top-4 rounded-xl border border-border bg-background/55 px-3 py-2">
              <div className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
                ACCURACY
              </div>
              <div className="font-heading text-[22px] font-bold text-primary">
                98.4%
              </div>
            </div>
            <div
              className="animate-float-y absolute bottom-4 right-4 rounded-xl border border-border bg-background/55 px-3 py-2"
              style={{ animationDelay: "0.8s" }}
            >
              <div className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
                LATENCY
              </div>
              <div className="font-heading text-[22px] font-bold text-[#34D6F5]">
                12ms
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURE_CARDS.map((card) => {
          const accent = ACCENT_CLASSES[card.accent]
          return (
            <Link
              key={card.title}
              href={card.href}
              className={`relative rounded-2xl border border-border bg-secondary/45 p-5 backdrop-blur-md transition-all hover:-translate-y-0.5 ${accent.hover}`}
            >
              {card.badge && (
                <span className="absolute right-4 top-4 rounded-md bg-[#F5B740]/16 px-2 py-0.5 font-mono text-[9px] tracking-[0.1em] text-[#F5B740]">
                  {card.badge}
                </span>
              )}
              <div
                className={`mb-4 flex size-[42px] items-center justify-center rounded-xl ${accent.iconWrap}`}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {card.icon}
                </svg>
              </div>
              <div className="mb-1.5 font-heading text-lg font-semibold">
                {card.title}
              </div>
              <div className="text-[13px] leading-relaxed text-muted-foreground">
                {card.desc}
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
