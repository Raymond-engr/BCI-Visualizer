"use client"

import { createContext, useContext, type ReactNode } from "react"

import { useBciEngine } from "@/hooks/useBciEngine"
import type { BciEngine } from "@/lib/bci/engine"

const BciEngineContext = createContext<BciEngine | null>(null)

export function BciEngineProvider({ children }: { children: ReactNode }) {
  const engine = useBciEngine()
  return (
    <BciEngineContext.Provider value={engine}>{children}</BciEngineContext.Provider>
  )
}

export function useBciEngineInstance(): BciEngine {
  const ctx = useContext(BciEngineContext)
  if (!ctx) {
    throw new Error("useBciEngineInstance must be used within a BciEngineProvider")
  }
  return ctx
}
