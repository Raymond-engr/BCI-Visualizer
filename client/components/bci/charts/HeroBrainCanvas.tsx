"use client"

import { useEffect, useRef } from "react"

import { useBciEngineInstance } from "@/contexts/BciEngineContext"

export function HeroBrainCanvas() {
  const engine = useBciEngineInstance()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    engine.registerCanvas("hero", canvasRef.current)
    return () => engine.registerCanvas("hero", null)
  }, [engine])

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
}
