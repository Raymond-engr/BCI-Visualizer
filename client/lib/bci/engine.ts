import * as THREE from "three"

import { CHAN, EPOS, MI, MI_COLOR, MI_LABEL, type MiClass } from "./constants"

export type ThreeCanvasKind = "field" | "hero" | "dash"
export type Chart2DKind = "wave" | "psd" | "topo"

export interface Telemetry {
  sessionTime: string
  miClass: MiClass
  miLabel: string
  miColor: string
  confidencePct: number
  epoch: number
  timestamp: string
}

type TelemetryListener = (t: Telemetry) => void
type ChannelLevelListener = (levels: readonly number[]) => void

interface ThreeSceneEntry {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  group: THREE.Group
  material: THREE.PointsMaterial
  canvas: HTMLCanvasElement
  kind: ThreeCanvasKind
  lastHeight?: number
}

/** Seeded PRNG (mulberry32) so demo output is stable across a session. */
function mulberry32(seed: number) {
  let a = seed
  return function rng() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Framework-agnostic simulation + rendering engine ported from the BCI
 * Visualizer design prototype. Screens mount/unmount their own canvases
 * (real routes, unlike the prototype's always-mounted single page), so
 * canvases are registered/unregistered rather than looked up by DOM id.
 */
export class BciEngine {
  private rng = mulberry32(1337)
  private wave: number[][] = Array.from({ length: 8 }, () => new Array(220).fill(0))
  private chanLvl: number[] = new Array(CHAN.length).fill(0).map(() => this.rng())
  private cur = { cls: "left_hand" as MiClass, conf: 0.79, epoch: 143, sec: 0 }
  private nextSwitch = 4.5
  private topoAcc = 0
  private motion = 55

  private scenes = new Map<ThreeCanvasKind, ThreeSceneEntry>()
  private canvases2D = new Map<Chart2DKind, HTMLCanvasElement>()

  private mouse = { x: 0, y: 0 }
  private onMouseMove = (e: MouseEvent) => {
    this.mouse.x = e.clientX / window.innerWidth - 0.5
    this.mouse.y = e.clientY / window.innerHeight - 0.5
  }

  private dashboardActive = false
  private raf = 0
  private t0 = 0
  private last = 0
  private lastTel = 0
  private running = false

  private telemetryListeners = new Set<TelemetryListener>()
  private channelListeners = new Set<ChannelLevelListener>()

  setDashboardActive(active: boolean) {
    this.dashboardActive = active
    if (active) this.cur.sec = 0
  }

  setMotion(motion: number) {
    this.motion = motion
  }

  subscribeTelemetry(cb: TelemetryListener) {
    this.telemetryListeners.add(cb)
    return () => {
      this.telemetryListeners.delete(cb)
    }
  }

  subscribeChannelLevels(cb: ChannelLevelListener) {
    this.channelListeners.add(cb)
    return () => {
      this.channelListeners.delete(cb)
    }
  }

  // ---------- three.js ----------
  private brainPoints(n: number) {
    const pos = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const u = this.rng()
      const v = this.rng()
      const th = Math.acos(2 * u - 1)
      const ph = 2 * Math.PI * v
      const r = 1 + (this.rng() - 0.5) * 0.18
      let x = Math.sin(th) * Math.cos(ph) * 1.32 * r
      let y = Math.cos(th) * 0.98 * r
      const z = Math.sin(th) * Math.sin(ph) * 1.06 * r
      y += 0.12 * Math.sin(z * 2)
      x += x > 0 ? 0.06 : -0.06
      pos[i * 3] = x
      pos[i * 3 + 1] = y
      pos[i * 3 + 2] = z
    }
    return pos
  }

  private makeScene(canvas: HTMLCanvasElement, kind: ThreeCanvasKind): ThreeSceneEntry {
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    camera.position.z = kind === "field" ? 4.6 : 3.2
    const group = new THREE.Group()
    scene.add(group)

    let material: THREE.PointsMaterial
    if (kind === "field") {
      const n = 1400
      const pos = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        pos[i * 3] = (this.rng() - 0.5) * 11
        pos[i * 3 + 1] = (this.rng() - 0.5) * 8
        pos[i * 3 + 2] = (this.rng() - 0.5) * 7
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
      material = new THREE.PointsMaterial({
        size: 0.03,
        color: 0x2fae7a,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      group.add(new THREE.Points(g, material))
    } else {
      const n = kind === "hero" ? 5200 : 2600
      const pos = this.brainPoints(n)
      const g = new THREE.BufferGeometry()
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
      material = new THREE.PointsMaterial({
        size: kind === "hero" ? 0.022 : 0.03,
        color: 0x37e29a,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      group.add(new THREE.Points(g, material))
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 24, 24),
        new THREE.MeshBasicMaterial({ color: 0x0c3a2a, transparent: true, opacity: 0.35 })
      )
      group.add(core)
    }

    return { renderer, scene, camera, group, material, canvas, kind }
  }

  registerCanvas(kind: ThreeCanvasKind, canvas: HTMLCanvasElement | null) {
    const existing = this.scenes.get(kind)
    if (existing) {
      existing.renderer.dispose()
      this.scenes.delete(kind)
    }
    if (canvas) this.scenes.set(kind, this.makeScene(canvas, kind))
  }

  registerCanvas2D(kind: Chart2DKind, canvas: HTMLCanvasElement | null) {
    if (canvas) this.canvases2D.set(kind, canvas)
    else this.canvases2D.delete(kind)
  }

  private resizeScene(s: ThreeSceneEntry) {
    const c = s.canvas
    const w = c.clientWidth
    const h = c.clientHeight
    if (w < 2 || h < 2) return false
    const dpr = Math.min(window.devicePixelRatio, 2)
    if (c.width !== Math.floor(w * dpr) || s.lastHeight !== h) {
      s.renderer.setSize(w, h, false)
      s.camera.aspect = w / h
      s.camera.updateProjectionMatrix()
      s.lastHeight = h
    }
    return true
  }

  private updateThree(dt: number, t: number) {
    const speed = this.motion / 55
    this.scenes.forEach((s) => {
      if (!this.resizeScene(s)) return
      if (s.kind === "field") {
        s.group.rotation.y += dt * 0.02 * speed
        s.group.rotation.x = Math.sin(t * 0.05) * 0.1
      } else if (s.kind === "hero") {
        s.group.rotation.y += dt * 0.18 * speed
        s.group.rotation.x += (this.mouse.y * 0.4 - s.group.rotation.x) * 0.05
        s.group.rotation.z = Math.sin(t * 0.3) * 0.04
        const p = 1 + Math.sin(t * 1.4) * 0.03
        s.group.scale.set(p, p, p)
      } else {
        s.group.rotation.y += dt * 0.5 * speed
        s.material.color.set(MI_COLOR[this.cur.cls])
        const p = 1 + Math.sin(t * 3) * 0.05 * (0.5 + this.cur.conf)
        s.group.scale.set(p, p, p)
      }
      s.renderer.render(s.scene, s.camera)
    })
  }

  // ---------- 2D charts ----------
  private fit(cv: HTMLCanvasElement) {
    const w = cv.clientWidth
    const h = cv.clientHeight
    const d = Math.min(window.devicePixelRatio, 2)
    if (cv.width !== w * d) {
      cv.width = w * d
      cv.height = h * d
    }
    return { ctx: cv.getContext("2d")!, w, h, d }
  }

  private drawWave(t: number) {
    const cv = this.canvases2D.get("wave")
    if (!cv || !cv.clientWidth) return
    const { ctx, w, h, d } = this.fit(cv)
    ctx.setTransform(d, 0, 0, d, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const amp = 1
    for (let c = 0; c < 8; c++) {
      const buf = this.wave[c]
      buf.shift()
      const f1 = 6 + c * 1.3
      const f2 = 11 + c * 0.7
      buf.push(Math.sin(t * f1 + c) * 0.5 + Math.sin(t * f2 * 0.5 + c * 2) * 0.35 + (this.rng() - 0.5) * 0.4)
      ctx.beginPath()
      const hue = 165 - c * 9
      ctx.strokeStyle = `hsla(${hue},75%,60%,.72)`
      ctx.lineWidth = 1.4
      const base = (c + 0.5) * (h / 8)
      for (let i = 0; i < buf.length; i++) {
        const x = (i / (buf.length - 1)) * w
        const y = base + buf[i] * (h / 8) * 0.7 * amp
        if (i) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
      }
      ctx.stroke()
    }
  }

  private drawPSD() {
    const cv = this.canvases2D.get("psd")
    if (!cv || !cv.clientWidth) return
    const { ctx, w, h, d } = this.fit(cv)
    ctx.setTransform(d, 0, 0, d, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const cls = this.cur.cls
    const muBoost = cls === "left_hand" || cls === "right_hand" ? 1.4 : 0.7
    const F = 80
    const vals: number[] = []
    for (let i = 0; i < F; i++) {
      const f = (i / F) * 40
      let p = 0.9 / (1 + f * 0.35)
      p += muBoost * 0.6 * Math.exp(-Math.pow((f - 10) / 2.4, 2))
      p += 0.5 * Math.exp(-Math.pow((f - 22) / 3.2, 2)) * (cls === "feet" ? 1.3 : 0.8)
      p += (this.rng() - 0.5) * 0.05
      vals.push(p)
    }
    const mx = Math.max(...vals) * 1.1
    const bandX = (a: number, b: number): [number, number] => [(a / 40) * w, (b / 40) * w]
    const [mx1, mx2] = bandX(8, 12)
    ctx.fillStyle = "rgba(52,214,245,.14)"
    ctx.fillRect(mx1, 0, mx2 - mx1, h)
    const [bx1, bx2] = bandX(18, 26)
    ctx.fillStyle = "rgba(154,107,242,.14)"
    ctx.fillRect(bx1, 0, bx2 - bx1, h)

    ctx.beginPath()
    ctx.moveTo(0, h)
    vals.forEach((p, i) => {
      const x = (i / (F - 1)) * w
      const y = h - (p / mx) * h * 0.92
      ctx.lineTo(x, y)
    })
    ctx.lineTo(w, h)
    ctx.closePath()
    const grd = ctx.createLinearGradient(0, 0, 0, h)
    grd.addColorStop(0, "rgba(55,226,154,.35)")
    grd.addColorStop(1, "rgba(55,226,154,0)")
    ctx.fillStyle = grd
    ctx.fill()

    ctx.beginPath()
    vals.forEach((p, i) => {
      const x = (i / (F - 1)) * w
      const y = h - (p / mx) * h * 0.92
      if (i) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    })
    ctx.strokeStyle = "rgba(234,245,239,.85)"
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  private topoColor(v: number): [number, number, number] {
    const stops: [number, number, number][] = [
      [10, 30, 90],
      [30, 120, 150],
      [55, 226, 154],
      [245, 183, 64],
      [240, 90, 70],
    ]
    const p = Math.max(0, Math.min(1, v)) * (stops.length - 1)
    const i = Math.floor(p)
    const f = p - i
    const a = stops[i]
    const b = stops[Math.min(i + 1, stops.length - 1)]
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
  }

  private drawTopo() {
    const cv = this.canvases2D.get("topo")
    if (!cv || !cv.clientWidth) return
    const { ctx, w, h, d } = this.fit(cv)
    ctx.setTransform(d, 0, 0, d, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const cx = w / 2
    const cy = h / 2
    const R = Math.min(w, h) / 2 - 8
    const cls = this.cur.cls

    const vals: Record<string, number> = {}
    for (const k in EPOS) {
      const [ex] = EPOS[k as keyof typeof EPOS]
      let v = 0.35 + 0.1 * this.rng()
      if (cls === "left_hand") v += ex > 0.1 ? 0.55 * this.cur.conf : 0
      else if (cls === "right_hand") v += ex < -0.1 ? 0.55 * this.cur.conf : 0
      else if (cls === "feet") v += Math.abs(ex) < 0.2 ? 0.5 * this.cur.conf : 0
      vals[k] = Math.min(1, v)
    }

    const iw = Math.floor(w)
    const ih = Math.floor(h)
    const img = ctx.createImageData(iw, ih)
    const dat = img.data
    const ent = Object.entries(EPOS)
    for (let py = 0; py < ih; py++) {
      for (let px = 0; px < iw; px++) {
        const dx = (px - cx) / R
        const dy = (py - cy) / R
        const dist = Math.sqrt(dx * dx + dy * dy)
        const idx = (py * iw + px) * 4
        if (dist > 1) {
          dat[idx + 3] = 0
          continue
        }
        let num = 0
        let den = 0
        for (let e = 0; e < ent.length; e++) {
          const [ex, ey] = ent[e][1]
          const wd = 1 / (Math.pow(dx - ex, 2) + Math.pow(dy - ey, 2) + 0.02)
          num += wd * vals[ent[e][0]]
          den += wd
        }
        const val = num / den
        const c = this.topoColor(val)
        dat[idx] = c[0]
        dat[idx + 1] = c[1]
        dat[idx + 2] = c[2]
        dat[idx + 3] = 225 * (1 - Math.pow(dist, 4))
      }
    }
    ctx.putImageData(img, 0, 0)

    ctx.strokeStyle = "rgba(234,245,239,.35)"
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(cx - 7, cy - R)
    ctx.lineTo(cx, cy - R - 8)
    ctx.lineTo(cx + 7, cy - R)
    ctx.stroke()
    for (const k in EPOS) {
      const [ex, ey] = EPOS[k as keyof typeof EPOS]
      ctx.beginPath()
      ctx.arc(cx + ex * R, cy + ey * R, 1.6, 0, Math.PI * 2)
      ctx.fillStyle = "rgba(234,245,239,.8)"
      ctx.fill()
    }
  }

  // ---------- master loop ----------
  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(0.05, (now - this.last) / 1000)
    this.last = now
    const t = (now - this.t0) / 1000

    this.updateThree(dt, t)

    if (this.dashboardActive) {
      this.cur.sec += dt
      if (t > this.nextSwitch) {
        this.nextSwitch = t + 3.5 + this.rng() * 3
        this.cur.cls = MI[Math.floor(this.rng() * MI.length)]
        this.cur.epoch++
      }
      this.cur.conf += (0.72 + this.rng() * 0.24 - this.cur.conf) * 0.06

      this.drawWave(t)
      this.drawPSD()
      this.topoAcc += dt
      if (this.topoAcc > 0.22) {
        this.topoAcc = 0
        this.drawTopo()
      }

      for (let i = 0; i < this.chanLvl.length; i++) {
        this.chanLvl[i] += (0.2 + this.rng() * 0.8 - this.chanLvl[i]) * 0.08
      }
      this.channelListeners.forEach((cb) => cb(this.chanLvl))

      if (now - this.lastTel > 140) {
        this.lastTel = now
        this.emitTelemetry()
      }
    }
  }

  private emitTelemetry() {
    const s = Math.floor(this.cur.sec)
    const hh = String(Math.floor(s / 3600)).padStart(2, "0")
    const mm = String(Math.floor(s / 60) % 60).padStart(2, "0")
    const ss = String(s % 60).padStart(2, "0")
    const telemetry: Telemetry = {
      sessionTime: `${hh}:${mm}:${ss}`,
      miClass: this.cur.cls,
      miLabel: MI_LABEL[this.cur.cls],
      miColor: MI_COLOR[this.cur.cls],
      confidencePct: Math.round(this.cur.conf * 1000) / 10,
      epoch: this.cur.epoch,
      timestamp: new Date().toTimeString().slice(0, 8),
    }
    this.telemetryListeners.forEach((cb) => cb(telemetry))
  }

  start() {
    if (this.running) return
    this.running = true
    window.addEventListener("mousemove", this.onMouseMove)
    this.t0 = performance.now()
    this.last = this.t0
    this.lastTel = 0
    this.raf = requestAnimationFrame(this.loop)
  }

  stop() {
    if (!this.running) return
    this.running = false
    cancelAnimationFrame(this.raf)
    window.removeEventListener("mousemove", this.onMouseMove)
    this.scenes.forEach((s) => {
      try {
        s.renderer.dispose()
      } catch {
        // canvas already detached
      }
    })
    this.scenes.clear()
    this.canvases2D.clear()
  }
}
