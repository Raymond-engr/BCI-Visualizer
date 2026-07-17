export type ElectrodePosition = {
  x: number; // left (-1) to right (+1) across the scalp
  y: number; // posterior (-1) to anterior (+1), nose at +y
};

export type Montage = {
  [label: string]: ElectrodePosition;
};

/**
 * BCI Competition IV Dataset 2a montage — 22 EEG electrodes arranged over the
 * sensorimotor cortex, ordered exactly as they appear in the GDF channel table.
 * Coordinates are the standard 10-20 azimuthal-equidistant projection onto the
 * unit circle, which is what the frontend topographic map interpolates over.
 */
export const bciciv2aMontage: Montage = {
  Fz: { x: 0.0, y: 0.5 },
  FC3: { x: -0.3, y: 0.32 },
  FC1: { x: -0.15, y: 0.28 },
  FCz: { x: 0.0, y: 0.27 },
  FC2: { x: 0.15, y: 0.28 },
  FC4: { x: 0.3, y: 0.32 },
  C5: { x: -0.6, y: 0.0 },
  C3: { x: -0.45, y: 0.0 },
  C1: { x: -0.22, y: 0.0 },
  Cz: { x: 0.0, y: 0.0 },
  C2: { x: 0.22, y: 0.0 },
  C4: { x: 0.45, y: 0.0 },
  C6: { x: 0.6, y: 0.0 },
  CP3: { x: -0.35, y: -0.3 },
  CP1: { x: -0.17, y: -0.28 },
  CPz: { x: 0.0, y: -0.27 },
  CP2: { x: 0.17, y: -0.28 },
  CP4: { x: 0.35, y: -0.3 },
  P1: { x: -0.2, y: -0.5 },
  Pz: { x: 0.0, y: -0.5 },
  P2: { x: 0.2, y: -0.5 },
  POz: { x: 0.0, y: -0.7 },
};

/**
 * The canonical channel order. Feature extraction indexes into the epoch by
 * position, so this array is the contract between the parser and the CSP
 * filters exported from the Python training pipeline.
 */
export const channelOrder: string[] = Object.keys(bciciv2aMontage);

/**
 * Electrodes sitting directly over the sensorimotor strip. Mu ERD during hand
 * Motor Imagery is strongest here, so these drive the classification features.
 */
export const motorChannels: string[] = ['C3', 'Cz', 'C4'];

/**
 * The channel whose Welch PSD is sent to the frontend spectrum panel.
 */
export const psdReferenceChannel = 'Cz';

/**
 * Frequency bands of interest, in Hz.
 */
export const bands = {
  mu: { low: 8, high: 12 },
  beta: { low: 18, high: 26 },
} as const;

export const montageConfig = {
  type: 'bciciv_2a',
  channelCount: channelOrder.length,
  sampleRate: 250,
};

/**
 * Returns the raw montage data for UI purposes (the frontend needs electrode
 * coordinates to place the scalp map dots).
 */
export const getMontageData = () => {
  return bciciv2aMontage;
};

/**
 * Look up an electrode's projected position.
 * @param label - Channel label as it appears in the GDF header.
 * @returns The position, or null when the label is not in the montage.
 */
export function getPosition(label: string): ElectrodePosition | null {
  return bciciv2aMontage[label] ?? null;
}

/**
 * Check whether a label belongs to this montage.
 * @param label - Channel label to validate.
 * @returns True when the electrode is known.
 */
export function isKnownChannel(label: string): boolean {
  return label in bciciv2aMontage;
}

/**
 * Resolve a channel label to its index in the canonical order.
 * @param label - Channel label to locate.
 * @returns Zero-based index, or -1 when absent.
 */
export function indexOfChannel(label: string): number {
  return channelOrder.indexOf(label);
}

/**
 * Reconcile a parsed file's channel labels against the canonical montage.
 * A recording is usable when every montage channel is present, regardless of
 * the order the file happens to store them in.
 * @param labels - Channel labels read from the uploaded recording.
 * @returns Whether the recording is usable and which channels are missing.
 */
export function reconcileChannels(labels: string[]): {
  compatible: boolean;
  missing: string[];
  extra: string[];
} {
  const upload = new Set(labels);
  const missing = channelOrder.filter((c) => !upload.has(c));
  const extra = labels.filter((l) => !isKnownChannel(l));

  return { compatible: missing.length === 0, missing, extra };
}
