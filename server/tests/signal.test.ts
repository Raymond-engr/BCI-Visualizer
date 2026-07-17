import {
  EpochBuffer,
  extractEpoch,
  epochRecording,
} from '../src/Signal_Processing/services/epoch.service';
import {
  welchPSD,
  bandPower,
  computeTopographic,
} from '../src/Signal_Processing/services/features.service';
import {
  reconcileChannels,
  indexOfChannel,
  getPosition,
  isKnownChannel,
  channelOrder,
  motorChannels,
} from '../src/utils/montage';

const sine = (freq: number, samples: number, amplitude = 1): number[] =>
  Array.from(
    { length: samples },
    (_, i) => amplitude * Math.sin((2 * Math.PI * freq * i) / 250)
  );

/** A ramp is easy to assert on, unlike a sine, when checking sample ordering. */
const ramp = (n: number, offset = 0): number[] =>
  Array.from({ length: n }, (_, i) => i + offset);

describe('epoch.service', () => {
  describe('EpochBuffer', () => {
    it('is not ready before a full epoch has arrived', () => {
      const buffer = new EpochBuffer(2, 100, 25);
      buffer.push([sine(10, 50), sine(10, 50)]);
      expect(buffer.ready).toBe(false);
    });

    it('is ready once the epoch length is reached', () => {
      const buffer = new EpochBuffer(2, 100, 25);
      buffer.push([sine(10, 100), sine(10, 100)]);
      expect(buffer.ready).toBe(true);
    });

    it('returns null instead of a short epoch when not yet full', () => {
      const buffer = new EpochBuffer(1, 100, 25);
      buffer.push([sine(10, 50)]);
      expect(buffer.extract()).toBeNull();
    });

    it('extracts an epoch of exactly the configured length', () => {
      const buffer = new EpochBuffer(2, 100, 25);
      buffer.push([sine(10, 100), sine(10, 100)]);
      const epoch = buffer.extract();
      expect(epoch).toHaveLength(2);
      expect(epoch![0]).toHaveLength(100);
    });

    it('returns samples in chronological order', () => {
      const buffer = new EpochBuffer(1, 10, 5);
      buffer.push([ramp(5)]);
      buffer.push([ramp(5, 5)]);
      expect(buffer.extract()![0]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('tracks how many samples it holds', () => {
      const buffer = new EpochBuffer(1, 100, 25);
      buffer.push([sine(10, 30)]);
      expect(buffer.length).toBe(30);
    });

    it('advances by the step size rather than clearing', () => {
      const buffer = new EpochBuffer(1, 100, 25);
      buffer.push([sine(10, 100)]);
      buffer.extract();

      // The window slid by one step, so 25 new samples complete the next epoch
      // rather than another full 100.
      expect(buffer.ready).toBe(false);
      expect(buffer.length).toBe(75);
      buffer.push([sine(10, 25)]);
      expect(buffer.ready).toBe(true);
    });

    it('overlaps successive epochs by epoch minus step', () => {
      const buffer = new EpochBuffer(1, 10, 5);
      buffer.push([ramp(10)]);
      const first = buffer.extract()!;
      buffer.push([ramp(5, 10)]);
      const second = buffer.extract()!;

      // 75%-style overlap: the tail of the first epoch is the head of the next.
      expect(second[0].slice(0, 5)).toEqual(first[0].slice(5));
      expect(second[0]).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    });

    it('wraps around its ring without corrupting order', () => {
      const buffer = new EpochBuffer(1, 10, 5);
      buffer.push([ramp(10)]);
      buffer.extract();
      buffer.push([ramp(5, 10)]);
      buffer.extract();
      buffer.push([ramp(5, 15)]);
      expect(buffer.extract()![0]).toEqual([
        10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
      ]);
    });

    it('keeps channels independent', () => {
      const buffer = new EpochBuffer(2, 5, 5);
      buffer.push([
        [1, 2, 3, 4, 5],
        [10, 20, 30, 40, 50],
      ]);
      const epoch = buffer.extract()!;
      expect(epoch[0]).toEqual([1, 2, 3, 4, 5]);
      expect(epoch[1]).toEqual([10, 20, 30, 40, 50]);
    });

    it('is empty again after reset', () => {
      const buffer = new EpochBuffer(1, 10, 5);
      buffer.push([ramp(10)]);
      buffer.reset();
      expect(buffer.ready).toBe(false);
      expect(buffer.length).toBe(0);
    });
  });

  describe('extractEpoch', () => {
    it('unwraps a ring starting from the write index', () => {
      const ring = [Float64Array.from([3, 4, 1, 2])];
      expect(extractEpoch(ring, 2, 4)).toEqual([[1, 2, 3, 4]]);
    });

    it('handles a ring whose write index is at zero', () => {
      const ring = [Float64Array.from([1, 2, 3, 4])];
      expect(extractEpoch(ring, 0, 4)).toEqual([[1, 2, 3, 4]]);
    });
  });

  describe('epochRecording', () => {
    it('produces overlapping windows across a recording', () => {
      // 1000 samples, 250-wide windows advancing 125 -> 7 complete windows.
      const epochs = epochRecording([sine(10, 1000)], 250, 125);
      expect(epochs).toHaveLength(7);
      expect(epochs[0][0]).toHaveLength(250);
    });

    it('drops a trailing partial window rather than zero-padding it', () => {
      expect(epochRecording([sine(10, 300)], 250, 125)).toHaveLength(1);
    });

    it('returns nothing for a recording shorter than one epoch', () => {
      expect(epochRecording([sine(10, 100)], 250, 125)).toHaveLength(0);
    });

    it('preserves channel count in every window', () => {
      const epochs = epochRecording([sine(10, 600), sine(20, 600)], 250, 125);
      epochs.forEach((epoch) => expect(epoch).toHaveLength(2));
    });
  });
});

describe('features.service', () => {
  describe('welchPSD', () => {
    it('places its peak at the frequency of a pure tone', () => {
      const psd = welchPSD(sine(10, 1000));
      const peak = psd.power.indexOf(Math.max(...psd.power));
      expect(psd.freqs[peak]).toBeCloseTo(10, 0);
    });

    it('tracks the peak when the tone moves', () => {
      const psd = welchPSD(sine(22, 1000));
      const peak = psd.power.indexOf(Math.max(...psd.power));
      expect(psd.freqs[peak]).toBeCloseTo(22, 0);
    });

    it('returns matching freqs and power arrays', () => {
      const psd = welchPSD(sine(10, 1000));
      expect(psd.freqs).toHaveLength(psd.power.length);
    });

    it('returns only non-negative frequencies', () => {
      const psd = welchPSD(sine(10, 1000));
      expect(Math.min(...psd.freqs)).toBeGreaterThanOrEqual(0);
    });

    it('grows with signal amplitude', () => {
      const quiet = Math.max(...welchPSD(sine(10, 1000, 1)).power);
      const loud = Math.max(...welchPSD(sine(10, 1000, 2)).power);
      expect(loud).toBeGreaterThan(quiet);
    });

    it('returns an empty spectrum for a signal too short to transform', () => {
      expect(welchPSD([1, 2, 3])).toEqual({ freqs: [], power: [] });
    });

    it('resolves two tones as two separate peaks', () => {
      const a = sine(10, 1000);
      const b = sine(25, 1000);
      const psd = welchPSD(a.map((v, i) => v + b[i]));

      const powerAt = (target: number) =>
        psd.power[psd.freqs.findIndex((f) => f >= target)];

      expect(powerAt(10)).toBeGreaterThan(powerAt(17));
      expect(powerAt(25)).toBeGreaterThan(powerAt(17));
    });
  });

  describe('bandPower', () => {
    it('finds more power in the band containing the tone', () => {
      const psd = welchPSD(sine(10, 1000));
      expect(bandPower(psd, 8, 12)).toBeGreaterThan(bandPower(psd, 20, 30));
    });

    it('returns zero for a band outside the spectrum', () => {
      expect(bandPower(welchPSD(sine(10, 1000)), 200, 300)).toBe(0);
    });

    it('returns zero for an empty spectrum', () => {
      expect(bandPower({ freqs: [], power: [] }, 8, 12)).toBe(0);
    });
  });

  describe('computeTopographic', () => {
    it('returns one value per named channel', () => {
      const names = ['C3', 'Cz', 'C4'];
      const topo = computeTopographic(
        names.map(() => sine(10, 1000)),
        names
      );
      expect(Object.keys(topo).sort()).toEqual([...names].sort());
    });

    it('gives a stronger reading to the channel with more Mu power', () => {
      const topo = computeTopographic(
        [sine(10, 1000, 3), sine(10, 1000, 0.5)],
        ['C3', 'C4']
      );
      expect(topo.C3).toBeGreaterThan(topo.C4);
    });

    it('reports near zero dB when all channels carry equal power', () => {
      const topo = computeTopographic(
        [sine(10, 1000), sine(10, 1000)],
        ['C3', 'C4']
      );
      // Values are relative to the montage mean, so uniform input is the origin.
      expect(topo.C3).toBeCloseTo(0, 3);
      expect(topo.C4).toBeCloseTo(0, 3);
    });

    it('separates Mu activity from out-of-band activity', () => {
      const topo = computeTopographic(
        [sine(10, 1000), sine(40, 1000)],
        ['C3', 'C4']
      );
      expect(topo.C3).toBeGreaterThan(topo.C4);
    });
  });
});

describe('montage', () => {
  it('lists 22 electrodes', () => {
    expect(channelOrder).toHaveLength(22);
  });

  it('includes the sensorimotor strip the pipeline depends on', () => {
    motorChannels.forEach((channel) => {
      expect(channelOrder).toContain(channel);
    });
  });

  it('resolves a known channel to its index', () => {
    expect(indexOfChannel('Cz')).toBeGreaterThanOrEqual(0);
  });

  it('returns -1 for an unknown channel', () => {
    expect(indexOfChannel('NotAnElectrode')).toBe(-1);
  });

  it('recognises a known electrode', () => {
    expect(isKnownChannel('C3')).toBe(true);
  });

  it('rejects an unknown electrode', () => {
    expect(isKnownChannel('EOG-left')).toBe(false);
  });

  it('gives a scalp position for a known electrode', () => {
    const position = getPosition('Cz');
    expect(position).not.toBeNull();
    expect(typeof position!.x).toBe('number');
    expect(typeof position!.y).toBe('number');
  });

  it('returns null for an unknown electrode', () => {
    expect(getPosition('NotAnElectrode')).toBeNull();
  });

  it('places Cz at the centre of the scalp projection', () => {
    const cz = getPosition('Cz')!;
    expect(cz.x).toBeCloseTo(0, 1);
    expect(cz.y).toBeCloseTo(0, 1);
  });

  it('places C3 and C4 on opposite sides of the midline', () => {
    expect(getPosition('C3')!.x).toBeLessThan(0);
    expect(getPosition('C4')!.x).toBeGreaterThan(0);
  });

  describe('reconcileChannels', () => {
    it('accepts the full reference montage', () => {
      const { compatible, missing, extra } = reconcileChannels(channelOrder);
      expect(compatible).toBe(true);
      expect(missing).toHaveLength(0);
      expect(extra).toHaveLength(0);
    });

    it('rejects a recording missing montage channels', () => {
      const { compatible, missing } = reconcileChannels(['C3', 'Cz']);
      expect(compatible).toBe(false);
      expect(missing.length).toBeGreaterThan(0);
    });

    it('reports unrecognised labels as extra', () => {
      const { extra } = reconcileChannels([...channelOrder, 'EOG-left']);
      expect(extra).toEqual(['EOG-left']);
    });

    it('stays compatible when extra channels are present', () => {
      const { compatible } = reconcileChannels([...channelOrder, 'EOG-left']);
      expect(compatible).toBe(true);
    });
  });
});
