"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { getAccessToken } from "@/lib/api/client"
import type { SessionMode } from "@/lib/api/types"
import {
  WS_URL,
  type ControlFrame,
  type DataPacket,
  type FilterSettings,
  type ServerMessage,
  type StreamConfig,
} from "@/lib/bci/stream"

export type StreamStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "completed"
  | "error"

export interface ConnectOptions {
  sessionId: string
  mode: SessionMode
  datasetId?: string
  hardwareWsUrl?: string
  modelId?: string
  notch?: boolean
  bandpassLow?: number
  bandpassHigh?: number
}

interface UseEegStreamOptions {
  /** Called ~25x a second. Do not set React state from here. */
  onPacket?: (packet: DataPacket) => void
  onConfig?: (config: StreamConfig) => void
}

export interface EegStream {
  status: StreamStatus
  error: string | null
  config: StreamConfig | null
  /** The filters currently in force, as the server reports them. */
  filters: FilterSettings | null
  connect: (options: ConnectOptions) => void
  disconnect: () => void
  sendControl: (frame: Omit<ControlFrame, "type">) => boolean
}

export function useEegStream(options: UseEegStreamOptions = {}): EegStream {
  const [status, setStatus] = useState<StreamStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const [config, setConfig] = useState<StreamConfig | null>(null)
  const [filters, setFilters] = useState<FilterSettings | null>(null)

  const socketRef = useRef<WebSocket | null>(null)
  /** Distinguishes a user-initiated close from a dropped connection. */
  const deliberateRef = useRef(false)

  /**
   * Latest-ref for the callbacks.
   *
   * Packets arrive 25x a second, so the consumer usually passes an inline
   * closure that changes identity every render. Reading through a ref keeps
   * `connect` stable — depending on the callbacks directly would tear the
   * socket down and restart the recording on every re-render.
   */
  const handlersRef = useRef(options)
  useEffect(() => {
    handlersRef.current = options
  })

  const connect = useCallback((connectOptions: ConnectOptions) => {
    socketRef.current?.close()
    deliberateRef.current = false

    const token = getAccessToken()
    if (!token) {
      setStatus("error")
      setError("You are not signed in")
      return
    }

    setStatus("connecting")
    setError(null)

    const ws = new WebSocket(WS_URL)
    socketRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "INIT", token, ...connectOptions }))
    }

    ws.onmessage = (event) => {
      let message: ServerMessage
      try {
        message = JSON.parse(event.data as string)
      } catch {
        return
      }

      if (message.type === "DATA_PACKET") {
        handlersRef.current.onPacket?.(message)
        return
      }

      if (message.type !== "STATUS") return

      switch (message.status) {
        case "STARTED":
          if (message.config) {
            setConfig(message.config)
            setFilters(message.config.filters)
            handlersRef.current.onConfig?.(message.config)
          }
          setStatus("streaming")
          break

        case "APPLIED":
          if (message.filters) setFilters(message.filters)
          setError(null)
          break

        case "COMPLETED":
          deliberateRef.current = true
          setStatus("completed")
          break

        case "ERROR":
          // A rejected CONTROL frame also reports ERROR, but carries the
          // filters still in force and leaves the stream running. Only a frame
          // without them is fatal.
          setError(message.message)
          if (message.filters) {
            setFilters(message.filters)
          } else {
            setStatus("error")
          }
          break
      }
    }

    ws.onerror = () => {
      if (deliberateRef.current) return
      setStatus("error")
      setError("Could not reach the streaming server")
    }

    ws.onclose = () => {
      socketRef.current = null
      if (deliberateRef.current) return

      // Closed without a COMPLETED frame and without us asking: the server
      // dropped us, so say so rather than silently freezing the dashboard.
      setStatus((prev) => (prev === "streaming" || prev === "connecting" ? "error" : prev))
      setError((prev) => prev ?? "The stream disconnected unexpectedly")
    }
  }, [])

  const disconnect = useCallback(() => {
    deliberateRef.current = true
    socketRef.current?.close(1000, "Client ended session")
    socketRef.current = null
    setStatus("idle")
  }, [])

  const sendControl = useCallback((frame: Omit<ControlFrame, "type">) => {
    const ws = socketRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify({ type: "CONTROL", ...frame }))
    return true
  }, [])

  // Leaving the dashboard must not leave the server streaming into a dead
  // socket; it holds a signal processor and an interval per connection.
  useEffect(() => {
    return () => {
      deliberateRef.current = true
      socketRef.current?.close(1000, "Component unmounted")
      socketRef.current = null
    }
  }, [])

  return { status, error, config, filters, connect, disconnect, sendControl }
}
