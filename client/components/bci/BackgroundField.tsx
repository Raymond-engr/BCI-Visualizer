"use client"

import { useEffect, useRef } from "react"

import { useBciEngineInstance } from "@/contexts/BciEngineContext"

/** Ambient particle field rendered once behind every screen. */
export function BackgroundField() {
  const engine = useBciEngineInstance()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    engine.registerCanvas("field", canvasRef.current)
    return () => engine.registerCanvas("field", null)
  }, [engine])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 h-full w-full opacity-90"
    />
  )
}
