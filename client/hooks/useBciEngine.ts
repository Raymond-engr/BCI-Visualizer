"use client"

import { useEffect, useState } from "react"

import { BciEngine } from "@/lib/bci/engine"

/**
 * Owns a single BciEngine instance for the app's lifetime. Instantiated once
 * at the root layout so its requestAnimationFrame loop survives route
 * navigation — screens register/unregister their own canvases into it.
 */
export function useBciEngine() {
  const [engine] = useState(() => new BciEngine())

  useEffect(() => {
    engine.start()
    return () => engine.stop()
  }, [engine])

  return engine
}
