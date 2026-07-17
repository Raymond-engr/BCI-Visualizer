"use client"

import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { useBciSession } from "@/contexts/BciSessionContext"
import { ONBOARDING_STEPS } from "@/lib/bci/constants"

const HIGHLIGHTS = [
  {
    dot: "#34D6F5",
    title: "Artifact Removal",
    desc: "ICA + EOG rejection filters out blinks and muscle noise automatically.",
  },
  {
    dot: "#9A6BF2",
    title: "CSP Spatial Filters",
    desc: "Common Spatial Patterns maximise variance between MI classes.",
  },
]

export function OnboardingScreen() {
  const router = useRouter()
  const { obStep, setObStep } = useBciSession()
  const step = ONBOARDING_STEPS[obStep - 1]

  function next() {
    if (obStep < ONBOARDING_STEPS.length) {
      setObStep(obStep + 1)
    } else {
      setObStep(1)
      router.push("/session-init")
    }
  }

  function prev() {
    if (obStep > 1) setObStep(obStep - 1)
    else router.push("/")
  }

  return (
    <div className="mx-auto w-full max-w-[560px] px-4 pb-20 pt-4 sm:px-6">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[11px] tracking-[0.1em] text-primary">
          ONBOARDING · PHASE {obStep} OF {ONBOARDING_STEPS.length}
        </span>
        <button
          onClick={() => router.push("/session-init")}
          className="font-mono text-xs text-muted-foreground"
        >
          Skip
        </button>
      </div>

      <div className="mb-6 flex gap-1.5">
        {ONBOARDING_STEPS.map((_, i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full ${
              obStep >= i + 1 ? "bg-primary" : "bg-border"
            }`}
          />
        ))}
      </div>

      <h2 className="mb-2 font-heading text-[28px] font-bold tracking-[-0.02em]">
        {step.title}
      </h2>
      <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
        {step.desc}
      </p>

      <div className="mb-7 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        {HIGHLIGHTS.map((h) => (
          <div
            key={h.title}
            className="rounded-2xl border border-border bg-secondary/40 p-4.5"
          >
            <div className="mb-2.5 flex items-center gap-2.5">
              <span
                className="size-2 rounded-full"
                style={{ background: h.dot }}
              />
              <span className="font-heading text-[15px] font-semibold">
                {h.title}
              </span>
            </div>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {h.desc}
            </p>
          </div>
        ))}
      </div>

      <div className="flex gap-3">
        <Button variant="outline" size="lg" onClick={prev}>
          Back
        </Button>
        <Button
          size="lg"
          className="h-auto flex-1 rounded-xl py-3.5 text-[15px] shadow-[0_8px_24px_rgba(55,226,154,.28)]"
          onClick={next}
        >
          {step.cta}
        </Button>
      </div>
    </div>
  )
}
