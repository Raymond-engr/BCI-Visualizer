import { streamingConfig } from '../../config/streaming';

/**
 * Sliding-window epoch buffer.
 *
 * Packets arrive 10 samples at a time but the classifier needs 4-second epochs,
 * so samples accumulate here until a full window exists. The window then
 * advances by `stepSamples` rather than being cleared, which is what produces
 * the 75% overlap the model was trained with and gives the dashboard a fresh
 * prediction every second instead of every four.
 *
 * The naive implementation — `buffer = [...buffer, ...incoming]` on every
 * packet — reallocates the whole buffer 25 times a second per channel. This
 * uses a fixed-capacity ring instead, so steady-state streaming does no
 * allocation at all.
 */
export class EpochBuffer {
  private readonly capacity: number;
  private readonly channels: number;
  private readonly data: Float64Array[];
  private writeIndex = 0;
  private filled = 0;

  constructor(
    channels: number,
    epochSamples: number = streamingConfig.epochSamples,
    private readonly stepSamples: number = streamingConfig.stepSamples
  ) {
    this.channels = channels;
    this.capacity = epochSamples;
    this.data = Array.from(
      { length: channels },
      () => new Float64Array(epochSamples)
    );
  }

  /**
   * Append one packet's worth of samples.
   * @param samples - Incoming samples, indexed [channel][sample].
   */
  push(samples: number[][]): void {
    const count = samples[0]?.length ?? 0;

    for (let s = 0; s < count; s++) {
      const slot = (this.writeIndex + s) % this.capacity;
      for (let c = 0; c < this.channels; c++) {
        this.data[c][slot] = samples[c][s];
      }
    }

    this.writeIndex = (this.writeIndex + count) % this.capacity;
    this.filled = Math.min(this.filled + count, this.capacity);
  }

  /** Whether a full epoch is available. */
  get ready(): boolean {
    return this.filled >= this.capacity;
  }

  /** Samples currently held. */
  get length(): number {
    return this.filled;
  }

  /**
   * Read the current epoch in chronological order and advance the window.
   * @returns The epoch indexed [channel][sample], or null when not yet full.
   */
  extract(): number[][] | null {
    if (!this.ready) return null;

    const epoch = extractEpoch(this.data, this.writeIndex, this.capacity);

    // Advance rather than clear: the next epoch reuses the overlapping tail.
    this.filled = this.capacity - this.stepSamples;

    return epoch;
  }

  /** Drop everything. Used when a session restarts on the same socket. */
  reset(): void {
    this.writeIndex = 0;
    this.filled = 0;
    this.data.forEach((channel) => channel.fill(0));
  }
}

/**
 * Unwrap a ring buffer into a plain chronological epoch.
 * @param ring - Backing storage, indexed [channel][slot].
 * @param writeIndex - Slot the next sample would be written to, i.e. the oldest
 *                     sample in a full ring.
 * @param capacity - Ring size in samples.
 * @returns The epoch indexed [channel][sample], oldest sample first.
 */
export function extractEpoch(
  ring: Float64Array[],
  writeIndex: number,
  capacity: number
): number[][] {
  return ring.map((channel) => {
    const out = new Array<number>(capacity);
    for (let s = 0; s < capacity; s++) {
      out[s] = channel[(writeIndex + s) % capacity];
    }
    return out;
  });
}

/**
 * Cut a recording into fixed overlapping epochs. Upload mode uses this to walk
 * a whole file offline, where the streaming ring buffer would add nothing.
 * @param samples - Full recording, indexed [channel][sample].
 * @param epochSamples - Window length.
 * @param stepSamples - Hop between successive windows.
 * @returns One entry per epoch, each indexed [channel][sample].
 */
export function epochRecording(
  samples: number[][],
  epochSamples: number = streamingConfig.epochSamples,
  stepSamples: number = streamingConfig.stepSamples
): number[][][] {
  const total = samples[0]?.length ?? 0;
  const epochs: number[][][] = [];

  for (let start = 0; start + epochSamples <= total; start += stepSamples) {
    epochs.push(
      samples.map((channel) => channel.slice(start, start + epochSamples))
    );
  }

  return epochs;
}
