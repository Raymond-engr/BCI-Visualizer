"use client"

import { createContext, useContext, useMemo, useState, type ReactNode } from "react"

import type { SessionSource, SettingsCategory } from "@/lib/bci/constants"

interface BciSessionState {
  obStep: number
  setObStep: (step: number) => void

  src: SessionSource
  setSrc: (src: SessionSource) => void

  datasetLabel: string
  setDatasetLabel: (label: string) => void

  bandpassLo: number
  bandpassHi: number
  setBandpass: (lo: number, hi: number) => void

  notchOn: boolean
  toggleNotch: () => void

  settingsCategory: SettingsCategory
  setSettingsCategory: (cat: SettingsCategory) => void
}

const BciSessionContext = createContext<BciSessionState | null>(null)

export function BciSessionProvider({ children }: { children: ReactNode }) {
  const [obStep, setObStep] = useState(1)
  const [src, setSrc] = useState<SessionSource>("sim")
  const [datasetLabel, setDatasetLabel] = useState("Live Simulation")
  const [bandpassLo, setBandpassLo] = useState(8)
  const [bandpassHi, setBandpassHi] = useState(30)
  const [notchOn, setNotchOn] = useState(true)
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("signal")

  const value = useMemo<BciSessionState>(
    () => ({
      obStep,
      setObStep,
      src,
      setSrc,
      datasetLabel,
      setDatasetLabel,
      bandpassLo,
      bandpassHi,
      setBandpass: (lo: number, hi: number) => {
        setBandpassLo(lo)
        setBandpassHi(hi)
      },
      notchOn,
      toggleNotch: () => setNotchOn((v) => !v),
      settingsCategory,
      setSettingsCategory,
    }),
    [obStep, src, datasetLabel, bandpassLo, bandpassHi, notchOn, settingsCategory]
  )

  return (
    <BciSessionContext.Provider value={value}>{children}</BciSessionContext.Provider>
  )
}

export function useBciSession(): BciSessionState {
  const ctx = useContext(BciSessionContext)
  if (!ctx) {
    throw new Error("useBciSession must be used within a BciSessionProvider")
  }
  return ctx
}
