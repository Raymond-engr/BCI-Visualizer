"use client"

import { useEffect, useRef } from "react"

import { useBciEngineInstance } from "@/contexts/BciEngineContext"

export function PSDChart() {
  const engine = useBciEngineInstance()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    engine.registerCanvas2D("psd", canvasRef.current)
    return () => engine.registerCanvas2D("psd", null)
  }, [engine])

  return <canvas ref={canvasRef} className="block h-[150px] w-full" />
}
