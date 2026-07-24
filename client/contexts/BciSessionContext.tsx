"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import { useAuth } from "@/contexts/AuthContext"
import { getPreferences } from "@/lib/api/preferences"
import type { SessionMode } from "@/lib/api/types"
import type { SessionSource, SettingsCategory } from "@/lib/bci/constants"

/**
 * The session reserved over REST, handed from the init screen to the dashboard
 * so the dashboard knows what to send in its INIT frame.
 */
export interface ActiveSession {
  sessionId: string
  mode: SessionMode
  datasetId?: string
  hardwareWsUrl?: string
}

interface BciSessionState {
  obStep: number
  setObStep: (step: number) => void

  src: SessionSource
  setSrc: (src: SessionSource) => void

  datasetLabel: string
  setDatasetLabel: (label: string) => void

  activeSession: ActiveSession | null
  setActiveSession: (session: ActiveSession | null) => void

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
  const { status } = useAuth()

  const [obStep, setObStep] = useState(1)
  const [src, setSrc] = useState<SessionSource>("sim")
  const [datasetLabel, setDatasetLabel] = useState("Live Simulation")
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null)
  const [bandpassLo, setBandpassLo] = useState(8)
  const [bandpassHi, setBandpassHi] = useState(30)
  const [notchOn, setNotchOn] = useState(true)
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("signal")

  /**
   * Seed the filter controls from the user's saved preferences once they are
   * signed in. The values above are only the defaults a signed-out visitor
   * sees; the server is the authority for a known user.
   */
  useEffect(() => {
    if (status !== "authenticated") return
    let cancelled = false

    getPreferences()
      .then((prefs) => {
        if (cancelled) return
        setBandpassLo(prefs.bandpassLow)
        setBandpassHi(prefs.bandpassHigh)
        setNotchOn(prefs.notchEnabled)
      })
      .catch(() => {
        // Falling back to the defaults is fine; this must not block the UI.
      })

    return () => {
      cancelled = true
    }
  }, [status])

  const value = useMemo<BciSessionState>(
    () => ({
      obStep,
      setObStep,
      src,
      setSrc,
      datasetLabel,
      setDatasetLabel,
      activeSession,
      setActiveSession,
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
    [
      obStep,
      src,
      datasetLabel,
      activeSession,
      bandpassLo,
      bandpassHi,
      notchOn,
      settingsCategory,
    ]
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
