"use client"

import { useEffect, useRef } from "react"

import { useBciEngineInstance } from "@/contexts/BciEngineContext"

export function TopoMapChart() {
  const engine = useBciEngineInstance()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    engine.registerCanvas2D("topo", canvasRef.current)
    return () => engine.registerCanvas2D("topo", null)
  }, [engine])

  return <canvas ref={canvasRef} className="block h-[150px] w-full" />
}
