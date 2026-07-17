"use client"

import { useEffect, useRef } from "react"

import { useBciEngineInstance } from "@/contexts/BciEngineContext"

export function DashboardBrainCanvas() {
  const engine = useBciEngineInstance()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    engine.registerCanvas("dash", canvasRef.current)
    return () => engine.registerCanvas("dash", null)
  }, [engine])

  return <canvas ref={canvasRef} className="block h-[150px] w-full" />
}
