import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import {
  CHAN,
  EPOS,
  MI_COLOR,
  MI_LABEL,
  MI_PENDING,
  TOPO_DB_RANGE,
  WAVE_CHANNELS,
  WAVE_SECONDS,
  type MiClass,
} from "./constants";
import type { DataPacket, StreamConfig } from "./stream";

export type ThreeCanvasKind = "field" | "hero" | "dash";
export type Chart2DKind = "wave" | "psd" | "topo";

export interface Telemetry {
  sessionTime: string;
  /** Null until the first epoch closes. */
  miClass: MiClass | null;
  miLabel: string;
  miColor: string;
  confidencePct: number;
  epoch: number;
  timestamp: string;
}

type TelemetryListener = (t: Telemetry) => void;
type ChannelLevelListener = (levels: readonly number[]) => void;

interface ThreeSceneEntry {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  group: THREE.Group;
  /** Only set for the "field" background scene's particle cloud. */
  material?: THREE.PointsMaterial;
  /** Only set for "hero"/"dash" once body.glb resolves — loading is async. */
  modelRoot?: THREE.Object3D | null;
  canvas: HTMLCanvasElement;
  kind: ThreeCanvasKind;
  lastHeight?: number;
}

/**
 * The upper-body model is loaded once and cloned per canvas ("hero" and
 * "dash" each get their own instance), so two scenes never share one live
 * object graph.
 */
let bodyModelPromise: Promise<THREE.Object3D> | null = null;

function loadBodyModel(): Promise<THREE.Object3D> {
  if (!bodyModelPromise) {
    bodyModelPromise = new GLTFLoader()
      .loadAsync("/models/body.glb")
      .then((gltf) => gltf.scene);
  }
  return bodyModelPromise;
}

/** Tints every mesh in the model — used to reflect the live MI classification. */
function tintModel(root: THREE.Object3D, color: THREE.ColorRepresentation) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];
    for (const mat of materials) {
      if (
        mat instanceof THREE.MeshStandardMaterial ||
        mat instanceof THREE.MeshPhysicalMaterial
      ) {
        mat.color.set(color);
        mat.emissive.set(color).multiplyScalar(0.15);
      }
    }
  });
}

/** Seeded PRNG (mulberry32) so the decorative point clouds are stable. */
function mulberry32(seed: number) {
  let a = seed;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_SAMPLE_RATE = 250;

/**
 * Renders the dashboard from the live EEG stream.
 *
 * The engine draws; it does not invent. Everything scientific on screen —
 * waveform, spectrum, scalp map, classification — arrives via
 * {@link pushPacket} and is rendered as received. The PRNG survives only for
 * the decorative three.js point clouds, which represent nothing.
 *
 * Screens mount/unmount their own canvases (real routes, unlike the prototype's
 * single always-mounted page), so canvases are registered rather than looked up
 * by DOM id.
 */
export class BciEngine {
  private rng = mulberry32(1337);

  // ---------- stream state ----------
  private sampleRate = DEFAULT_SAMPLE_RATE;
  private channelNames: string[] = [...CHAN];
  /** Indices into `channelNames` for the eight traces the waveform card shows. */
  private waveIndices: number[] = [];
  private waveLength = DEFAULT_SAMPLE_RATE * WAVE_SECONDS;
  private wave: number[][] = [];
  /**
   * Running peak amplitude used to normalise the traces. EEG is delivered in
   * microvolts and its scale varies by an order of magnitude between subjects,
   * so a fixed gain would either clip or flatline. Rises instantly and decays
   * slowly, so a transient artifact doesn't permanently shrink the trace.
   */
  private waveScale = 1;
  private levelScale = 1;
  private chanLvl: number[] = new Array(CHAN.length).fill(0);

  private psd: { freqs: number[]; power: number[] } | null = null;
  private topo: Record<string, number> | null = null;

  private cls: MiClass | null = null;
  private conf = 0;
  private epoch = -1;

  /** First packet's timestamp, so the clock reads from zero. */
  private streamT0: number | null = null;
  private streamSeconds = 0;

  private scenes = new Map<ThreeCanvasKind, ThreeSceneEntry>();
  private canvases2D = new Map<Chart2DKind, HTMLCanvasElement>();

  private mouse = { x: 0, y: 0 };
  private onMouseMove = (e: MouseEvent) => {
    this.mouse.x = e.clientX / window.innerWidth - 0.5;
    this.mouse.y = e.clientY / window.innerHeight - 0.5;
  };

  private dashboardActive = false;
  private raf = 0;
  private t0 = 0;
  private last = 0;
  private lastTel = 0;
  private topoAcc = 0;
  private motion = 55;
  private running = false;

  private telemetryListeners = new Set<TelemetryListener>();
  private channelListeners = new Set<ChannelLevelListener>();

  constructor() {
    this.resetBuffers();
  }

  setDashboardActive(active: boolean) {
    this.dashboardActive = active;
  }

  setMotion(motion: number) {
    this.motion = motion;
  }

  subscribeTelemetry(cb: TelemetryListener) {
    this.telemetryListeners.add(cb);
    return () => {
      this.telemetryListeners.delete(cb);
    };
  }

  subscribeChannelLevels(cb: ChannelLevelListener) {
    this.channelListeners.add(cb);
    return () => {
      this.channelListeners.delete(cb);
    };
  }

  // ---------- stream ingest ----------

  private resetBuffers() {
    this.waveLength = Math.max(2, Math.round(this.sampleRate * WAVE_SECONDS));
    this.waveIndices = WAVE_CHANNELS.map((name) =>
      this.channelNames.indexOf(name),
    ).filter((index) => index >= 0);
    this.wave = this.waveIndices.map(() => new Array(this.waveLength).fill(0));
    this.chanLvl = new Array(this.channelNames.length).fill(0);
    this.waveScale = 1;
    this.levelScale = 1;
  }

  /**
   * Adopt the montage and sample rate the server reported on STARTED, so the
   * dashboard lays itself out from the stream rather than from a hardcoded
   * assumption about the recording.
   */
  configure(config: StreamConfig) {
    this.sampleRate = config.sampleRate || DEFAULT_SAMPLE_RATE;
    this.channelNames = config.channelNames?.length
      ? config.channelNames
      : [...CHAN];
    this.resetBuffers();
  }

  /** Clear every trace of the previous session. */
  resetStream() {
    this.sampleRate = DEFAULT_SAMPLE_RATE;
    this.channelNames = [...CHAN];
    this.resetBuffers();
    this.psd = null;
    this.topo = null;
    this.cls = null;
    this.conf = 0;
    this.epoch = -1;
    this.streamT0 = null;
    this.streamSeconds = 0;
    this.emitTelemetry();
  }

  /**
   * Ingest one packet.
   *
   * `samples` is on every packet; `psd`, `topographic` and `classification`
   * only appear on the ~1 in 25 that closes an epoch. The last analysis seen is
   * retained deliberately — the waveform keeps scrolling underneath a
   * classification that is, correctly, a second old.
   */
  pushPacket(packet: DataPacket) {
    if (this.streamT0 === null) this.streamT0 = packet.timestamp;
    // Stream time, not wall time: upload mode replays at 8x, so a clock driven
    // by Date.now() would disagree with the data being drawn.
    this.streamSeconds = Math.max(0, packet.timestamp - this.streamT0);

    if (packet.samples?.length) {
      this.appendSamples(packet.samples);
      this.updateChannelLevels(packet.samples);
    }

    if (packet.epochIndex >= 0) this.epoch = packet.epochIndex;
    if (packet.psd) this.psd = packet.psd;
    if (packet.topographic) this.topo = packet.topographic;

    if (packet.classification) {
      this.cls = packet.classification.predictedClass;
      this.conf = packet.classification.confidence;
    }
  }

  private appendSamples(samples: number[][]) {
    let peak = 0;

    this.waveIndices.forEach((channelIndex, traceIndex) => {
      const incoming = samples[channelIndex];
      if (!incoming?.length) return;

      const buffer = this.wave[traceIndex];
      for (const value of incoming) {
        buffer.push(value);
        const magnitude = Math.abs(value);
        if (magnitude > peak) peak = magnitude;
      }

      const overflow = buffer.length - this.waveLength;
      if (overflow > 0) buffer.splice(0, overflow);
    });

    // Attack immediately, decay ~2.5% a second at 25 packets/s.
    this.waveScale = Math.max(peak, this.waveScale * 0.999, 1e-6);
  }

  private updateChannelLevels(samples: number[][]) {
    let maxRms = 0;
    const rms = samples.map((channel) => {
      if (!channel?.length) return 0;
      let sum = 0;
      for (const value of channel) sum += value * value;
      const value = Math.sqrt(sum / channel.length);
      if (value > maxRms) maxRms = value;
      return value;
    });

    this.levelScale = Math.max(maxRms, this.levelScale * 0.999, 1e-6);

    for (let i = 0; i < this.chanLvl.length; i++) {
      const target = Math.min(1, (rms[i] ?? 0) / this.levelScale);
      this.chanLvl[i] += (target - this.chanLvl[i]) * 0.3;
    }
  }

  // ---------- three.js ----------
  private makeScene(
    canvas: HTMLCanvasElement,
    kind: ThreeCanvasKind,
  ): ThreeSceneEntry {
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = kind === "field" ? 4.6 : 3.2;
    const group = new THREE.Group();
    scene.add(group);

    if (kind === "field") {
      const n = 1400;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = (this.rng() - 0.5) * 11;
        pos[i * 3 + 1] = (this.rng() - 0.5) * 8;
        pos[i * 3 + 2] = (this.rng() - 0.5) * 7;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const material = new THREE.PointsMaterial({
        size: 0.03,
        color: 0x2fae7a,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      group.add(new THREE.Points(g, material));
      return { renderer, scene, camera, group, material, canvas, kind };
    }

    // "hero" and "dash": a lit, loaded human upper-body model in place of the
    // old procedural point cloud. Lights are added to the scene rather than
    // the group so they don't spin along with the model.
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    keyLight.position.set(2, 3, 4);
    scene.add(keyLight);

    const entry: ThreeSceneEntry = {
      renderer,
      scene,
      camera,
      group,
      canvas,
      kind,
    };

    loadBodyModel()
      .then((model) => {
        const instance = model.clone(true);
        instance.scale.setScalar(kind === "hero" ? 1.4 : 1.1);
        instance.position.y = -1;
        group.add(instance);
        entry.modelRoot = instance;
        if (kind === "dash") tintModel(instance, MI_PENDING.color);
      })
      .catch((error: unknown) => {
        console.error("Failed to load /models/body.glb", error);
      });

    return entry;
  }

  registerCanvas(kind: ThreeCanvasKind, canvas: HTMLCanvasElement | null) {
    const existing = this.scenes.get(kind);
    if (existing) {
      existing.renderer.dispose();
      this.scenes.delete(kind);
    }
    if (canvas) this.scenes.set(kind, this.makeScene(canvas, kind));
  }

  registerCanvas2D(kind: Chart2DKind, canvas: HTMLCanvasElement | null) {
    if (canvas) this.canvases2D.set(kind, canvas);
    else this.canvases2D.delete(kind);
  }

  private resizeScene(s: ThreeSceneEntry) {
    const c = s.canvas;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (w < 2 || h < 2) return false;
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (c.width !== Math.floor(w * dpr) || s.lastHeight !== h) {
      s.renderer.setSize(w, h, false);
      s.camera.aspect = w / h;
      s.camera.updateProjectionMatrix();
      s.lastHeight = h;
    }
    return true;
  }

  private updateThree(dt: number, t: number) {
    const speed = this.motion / 55;
    this.scenes.forEach((s) => {
      if (!this.resizeScene(s)) return;
      if (s.kind === "field") {
        s.group.rotation.y += dt * 0.02 * speed;
        s.group.rotation.x = Math.sin(t * 0.05) * 0.1;
      } else if (s.kind === "hero") {
        s.group.rotation.y += dt * 0.18 * speed;
        s.group.rotation.x += (this.mouse.y * 0.4 - s.group.rotation.x) * 0.05;
        s.group.rotation.z = Math.sin(t * 0.3) * 0.04;
        const p = 1 + Math.sin(t * 1.4) * 0.03;
        s.group.scale.set(p, p, p);
      } else {
        s.group.rotation.y += dt * 0.5 * speed;
        if (s.modelRoot) {
          tintModel(
            s.modelRoot,
            this.cls ? MI_COLOR[this.cls] : MI_PENDING.color,
          );
        }
        const p = 1 + Math.sin(t * 3) * 0.05 * (0.5 + this.conf);
        s.group.scale.set(p, p, p);
      }
      s.renderer.render(s.scene, s.camera);
    });
  }

  // ---------- 2D charts ----------
  private fit(cv: HTMLCanvasElement) {
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    const d = Math.min(window.devicePixelRatio, 2);
    if (cv.width !== w * d) {
      cv.width = w * d;
      cv.height = h * d;
    }
    return { ctx: cv.getContext("2d")!, w, h, d };
  }

  private drawWave() {
    const cv = this.canvases2D.get("wave");
    if (!cv || !cv.clientWidth) return;
    const { ctx, w, h, d } = this.fit(cv);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const traces = this.wave.length;
    if (!traces) return;

    const lane = h / traces;
    for (let c = 0; c < traces; c++) {
      const buf = this.wave[c];
      ctx.beginPath();
      ctx.strokeStyle = `hsla(${165 - c * 9},75%,60%,.72)`;
      ctx.lineWidth = 1.4;
      const base = (c + 0.5) * lane;

      for (let i = 0; i < buf.length; i++) {
        const x = (i / (buf.length - 1)) * w;
        const y = base + (buf[i] / this.waveScale) * lane * 0.7;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
  }

  private drawPSD() {
    const cv = this.canvases2D.get("psd");
    if (!cv || !cv.clientWidth) return;
    const { ctx, w, h, d } = this.fit(cv);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // The panel's axis is fixed at 0-40 Hz, which is also where the server
    // truncates the spectrum it sends.
    const maxFreq = 40;
    const bandX = (a: number, b: number): [number, number] => [
      (a / maxFreq) * w,
      (b / maxFreq) * w,
    ];
    const [mx1, mx2] = bandX(8, 12);
    ctx.fillStyle = "rgba(52,214,245,.14)";
    ctx.fillRect(mx1, 0, mx2 - mx1, h);
    const [bx1, bx2] = bandX(18, 26);
    ctx.fillStyle = "rgba(154,107,242,.14)";
    ctx.fillRect(bx1, 0, bx2 - bx1, h);

    const psd = this.psd;
    if (!psd || psd.freqs.length < 2) return;

    let peak = 0;
    for (const p of psd.power) if (p > peak) peak = p;
    const mx = peak > 0 ? peak * 1.1 : 1;

    const pointAt = (i: number): [number, number] => [
      (psd.freqs[i] / maxFreq) * w,
      h - (psd.power[i] / mx) * h * 0.92,
    ];

    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < psd.freqs.length; i++) {
      const [x, y] = pointAt(i);
      ctx.lineTo(x, y);
    }
    ctx.lineTo((psd.freqs[psd.freqs.length - 1] / maxFreq) * w, h);
    ctx.closePath();
    const grd = ctx.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, "rgba(55,226,154,.35)");
    grd.addColorStop(1, "rgba(55,226,154,0)");
    ctx.fillStyle = grd;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < psd.freqs.length; i++) {
      const [x, y] = pointAt(i);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = "rgba(234,245,239,.85)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  private topoColor(v: number): [number, number, number] {
    const stops: [number, number, number][] = [
      [10, 30, 90],
      [30, 120, 150],
      [55, 226, 154],
      [245, 183, 64],
      [240, 90, 70],
    ];
    const p = Math.max(0, Math.min(1, v)) * (stops.length - 1);
    const i = Math.floor(p);
    const f = p - i;
    const a = stops[i];
    const b = stops[Math.min(i + 1, stops.length - 1)];
    return [
      a[0] + (b[0] - a[0]) * f,
      a[1] + (b[1] - a[1]) * f,
      a[2] + (b[2] - a[2]) * f,
    ];
  }

  private drawTopo() {
    const cv = this.canvases2D.get("topo");
    if (!cv || !cv.clientWidth) return;
    const { ctx, w, h, d } = this.fit(cv);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 8;

    const outline = () => {
      ctx.strokeStyle = "rgba(234,245,239,.35)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 7, cy - R);
      ctx.lineTo(cx, cy - R - 8);
      ctx.lineTo(cx + 7, cy - R);
      ctx.stroke();
      for (const k in EPOS) {
        const [ex, ey] = EPOS[k as keyof typeof EPOS];
        ctx.beginPath();
        ctx.arc(cx + ex * R, cy + ey * R, 1.6, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(234,245,239,.8)";
        ctx.fill();
      }
    };

    // Before the first epoch there is no scalp map to draw, but the head
    // outline should still be there rather than an empty panel.
    if (!this.topo) return outline();

    // The server sends Mu power in dB relative to the epoch's own mean across
    // electrodes, so 0 dB sits mid-ramp: blue is ERD (suppression, the
    // contralateral signature of motor imagery) and amber/red is ERS.
    const vals: Record<string, number> = {};
    for (const k in EPOS) {
      const db = this.topo[k];
      vals[k] =
        db === undefined
          ? 0.5
          : Math.max(
              0,
              Math.min(1, (db + TOPO_DB_RANGE) / (2 * TOPO_DB_RANGE)),
            );
    }

    const iw = Math.floor(w);
    const ih = Math.floor(h);
    if (iw < 1 || ih < 1) return;
    const img = ctx.createImageData(iw, ih);
    const dat = img.data;
    const ent = Object.entries(EPOS);
    for (let py = 0; py < ih; py++) {
      for (let px = 0; px < iw; px++) {
        const dx = (px - cx) / R;
        const dy = (py - cy) / R;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const idx = (py * iw + px) * 4;
        if (dist > 1) {
          dat[idx + 3] = 0;
          continue;
        }
        let num = 0;
        let den = 0;
        for (let e = 0; e < ent.length; e++) {
          const [ex, ey] = ent[e][1];
          const wd = 1 / (Math.pow(dx - ex, 2) + Math.pow(dy - ey, 2) + 0.02);
          num += wd * vals[ent[e][0]];
          den += wd;
        }
        const c = this.topoColor(num / den);
        dat[idx] = c[0];
        dat[idx + 1] = c[1];
        dat[idx + 2] = c[2];
        dat[idx + 3] = 225 * (1 - Math.pow(dist, 4));
      }
    }
    ctx.putImageData(img, 0, 0);
    outline();
  }

  // ---------- master loop ----------
  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const t = (now - this.t0) / 1000;

    this.updateThree(dt, t);

    if (!this.dashboardActive) return;

    this.drawWave();
    this.drawPSD();

    // The scalp map is a per-pixel inverse-distance interpolation over 22
    // electrodes — far too costly for every frame, and it only changes once an
    // epoch anyway.
    this.topoAcc += dt;
    if (this.topoAcc > 0.22) {
      this.topoAcc = 0;
      this.drawTopo();
    }

    this.channelListeners.forEach((cb) => cb(this.chanLvl));

    if (now - this.lastTel > 140) {
      this.lastTel = now;
      this.emitTelemetry();
    }
  };

  private emitTelemetry() {
    const s = Math.floor(this.streamSeconds);
    const hh = String(Math.floor(s / 3600)).padStart(2, "0");
    const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");

    const telemetry: Telemetry = {
      sessionTime: `${hh}:${mm}:${ss}`,
      miClass: this.cls,
      miLabel: this.cls ? MI_LABEL[this.cls] : MI_PENDING.label,
      miColor: this.cls ? MI_COLOR[this.cls] : MI_PENDING.color,
      confidencePct: Math.round(this.conf * 1000) / 10,
      epoch: this.epoch,
      timestamp: new Date().toTimeString().slice(0, 8),
    };
    this.telemetryListeners.forEach((cb) => cb(telemetry));
  }

  start() {
    if (this.running) return;
    this.running = true;
    window.addEventListener("mousemove", this.onMouseMove);
    this.t0 = performance.now();
    this.last = this.t0;
    this.lastTel = 0;
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("mousemove", this.onMouseMove);
    this.scenes.forEach((s) => {
      try {
        s.renderer.dispose();
      } catch {
        // canvas already detached
      }
    });
    this.scenes.clear();
    this.canvases2D.clear();
  }
}
