export const CHAN = [
  "Fz", "FC3", "FC1", "FCz", "FC2", "FC4",
  "C5", "C3", "C1", "Cz", "C2", "C4", "C6",
  "CP3", "CP1", "CPz", "CP2", "CP4",
  "P1", "Pz", "P2", "POz",
] as const

/** Unit-circle electrode positions used to interpolate the scalp topomap. */
export const EPOS: Record<(typeof CHAN)[number], [number, number]> = {
  Fz: [0, -0.62],
  FC3: [-0.34, -0.4],
  FC1: [-0.14, -0.42],
  FCz: [0, -0.4],
  FC2: [0.14, -0.42],
  FC4: [0.34, -0.4],
  C5: [-0.7, 0],
  C3: [-0.44, 0],
  C1: [-0.16, 0],
  Cz: [0, 0],
  C2: [0.16, 0],
  C4: [0.44, 0],
  C6: [0.7, 0],
  CP3: [-0.34, 0.4],
  CP1: [-0.14, 0.42],
  CPz: [0, 0.4],
  CP2: [0.14, 0.42],
  CP4: [0.34, 0.4],
  P1: [-0.18, 0.62],
  Pz: [0, 0.64],
  P2: [0.18, 0.62],
  POz: [0, 0.82],
}

/** Motor Imagery classes this engine decodes. */
export const MI = ["left_hand", "right_hand", "feet"] as const
export type MiClass = (typeof MI)[number]

export const MI_LABEL: Record<MiClass, string> = {
  left_hand: "LEFT HAND",
  right_hand: "RIGHT HAND",
  feet: "FEET",
}

/** Sentence-case form, for prose contexts like the session breakdown. */
export const MI_TITLE: Record<MiClass, string> = {
  left_hand: "Left Hand",
  right_hand: "Right Hand",
  feet: "Feet",
}

export const MI_COLOR: Record<MiClass, string> = {
  left_hand: "#34D6F5",
  right_hand: "#9A6BF2",
  feet: "#37E29A",
}

/**
 * Shown on the classification badge before the first epoch closes. An epoch is
 * four seconds wide, so a real stream genuinely has nothing to predict for its
 * first few seconds — that gap is a fact about the pipeline, not a loading state.
 */
export const MI_PENDING = { label: "AWAITING", color: "#9db4a9" } as const

/**
 * The eight electrodes drawn in the waveform card. The stream carries all 22,
 * but the panel is laid out for eight traces, so these are the sensorimotor
 * strip — where Mu ERD during hand imagery actually shows up — rather than the
 * first eight in montage order, which would be mostly frontal.
 */
export const WAVE_CHANNELS = [
  "FC3", "C5", "C3", "C1", "Cz", "C2", "C4", "C6",
] as const

/** Seconds of signal held in the waveform buffer. Matches the epoch window. */
export const WAVE_SECONDS = 4

/**
 * Half-range, in dB, of the topographic colour scale. The server sends Mu power
 * relative to the epoch's mean across electrodes, so 0 dB is the middle of the
 * ramp and +/- this value saturates it.
 */
export const TOPO_DB_RANGE = 6

export type SessionSource = "upload" | "sim" | "hw"

export const SOURCE_LABEL: Record<SessionSource, string> = {
  upload: "DATASET",
  sim: "SIMULATION",
  hw: "HARDWARE",
}

export const SOURCE_CONNECT_COPY: Record<SessionSource, { connecting: string; dataset: string }> = {
  upload: { connecting: "Parsing GDF/CSV recording…", dataset: "Uploaded Recording" },
  sim: { connecting: "Loading pre-recorded BCI stream…", dataset: "Live Simulation" },
  hw: { connecting: "Pairing OpenBCI / BLE headset…", dataset: "OpenBCI Cyton" },
}

export const ONBOARDING_STEPS = [
  {
    title: "Precision decoding, ready to go",
    desc: "Your engine decodes Motor Imagery signals with lab-grade precision across three mental tasks — left hand, right hand, and feet.",
    cta: "Continue",
  },
  {
    title: "Tune your signal chain",
    desc: "Bandpass and notch filters are pre-configured for the 8–30 Hz motor rhythm band. Adjust anytime from the dashboard sidebar.",
    cta: "Continue",
  },
  {
    title: "You are calibrated",
    desc: "The global CSP+LDA model is loaded. Launch a session to begin real-time decoding.",
    cta: "Enter Dashboard",
  },
] as const

export type SettingsCategory = "signal" | "hardware"

export const SETTINGS_CATEGORIES: Record<
  SettingsCategory,
  {
    title: string
    rows: [
      { title: string; desc: string },
      { title: string; desc: string },
      { title: string; value: string },
    ]
  }
> = {
  signal: {
    title: "Signal Processing",
    rows: [
      { title: "Real-time filtering", desc: "Apply bandpass + notch during streaming" },
      { title: "Auto artifact rejection", desc: "ICA-based blink and EMG removal" },
      { title: "Epoch window", value: "4.0 s" },
    ],
  },
  hardware: {
    title: "Hardware",
    rows: [
      { title: "Auto-reconnect", desc: "Reconnect dropped BLE headsets" },
      { title: "Impedance check", desc: "Warn on poor electrode contact" },
      { title: "Sample rate", value: "250 Hz" },
    ],
  },
}

