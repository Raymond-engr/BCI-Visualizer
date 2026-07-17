import { SignalProcessor } from '../src/Signal_Processing/services/signalProcessor.service';
import { streamingConfig } from '../src/config/streaming';
import { channelOrder } from '../src/utils/montage';

jest.mock('../src/Signal_Processing/services/features.service', () => {
  const actual = jest.requireActual(
    '../src/Signal_Processing/services/features.service'
  );
  return {
    ...actual,
    // CSP filters come from a trained model file that is not present in CI.
    // The projection is exercised by its own tests; here the concern is the
    // rate at which analysis is produced, not its contents.
    computeCSPFeatures: jest.fn(() => [0.1, 0.2, 0.3, 0.4]),
  };
});

const { packetSamples, stepSamples, epochSamples, sampleRate } =
  streamingConfig;

/** One packet of noise for every channel in the montage. */
const packet = (n = packetSamples): number[][] =>
  channelOrder.map(() =>
    Array.from({ length: n }, (_, i) => Math.sin(i / 3) + Math.random() * 0.1)
  );

describe('SignalProcessor', () => {
  describe('output rates', () => {
    it('returns filtered samples for every packet', () => {
      const processor = new SignalProcessor();
      for (let i = 0; i < 5; i++) {
        const { filtered } = processor.process(packet(), channelOrder);
        expect(filtered).toHaveLength(channelOrder.length);
        expect(filtered[0]).toHaveLength(packetSamples);
      }
    });

    it('produces no analysis while the epoch buffer is still filling', () => {
      const processor = new SignalProcessor();
      const packetsToFirstEpoch = epochSamples / packetSamples;

      for (let i = 0; i < packetsToFirstEpoch - 1; i++) {
        expect(processor.process(packet(), channelOrder).analysis).toBeNull();
      }
    });

    it('produces analysis on the packet that completes the first epoch', () => {
      const processor = new SignalProcessor();
      const packetsToFirstEpoch = epochSamples / packetSamples;

      let last = null;
      for (let i = 0; i < packetsToFirstEpoch; i++) {
        last = processor.process(packet(), channelOrder).analysis;
      }

      expect(last).not.toBeNull();
      expect(last!.psd.freqs.length).toBeGreaterThan(0);
      expect(Object.keys(last!.topographic)).toHaveLength(channelOrder.length);
    });

    it('emits waveform 25x more often than analysis, not once per second only', () => {
      // The regression this guards: analysis and waveform were fused, so 24 of
      // every 25 packets were dropped entirely and the client received ~4% of
      // the signal.
      const processor = new SignalProcessor();
      const seconds = 4;
      const packets = (sampleRate * seconds) / packetSamples;

      let waveformPackets = 0;
      let analysisPackets = 0;

      for (let i = 0; i < packets; i++) {
        const { filtered, analysis } = processor.process(
          packet(),
          channelOrder
        );
        if (filtered.length) waveformPackets++;
        if (analysis) analysisPackets++;
      }

      expect(waveformPackets).toBe(packets);

      // One epoch per step, after the first epoch's worth of fill.
      const expectedAnalysis =
        Math.floor((sampleRate * seconds - epochSamples) / stepSamples) + 1;
      expect(analysisPackets).toBe(expectedAnalysis);
      expect(waveformPackets / analysisPackets).toBeGreaterThan(10);
    });

    it('delivers every sample it is given', () => {
      const processor = new SignalProcessor();
      let delivered = 0;

      for (let i = 0; i < 100; i++) {
        delivered += processor.process(packet(), channelOrder).filtered[0]
          .length;
      }

      expect(delivered).toBe(100 * packetSamples);
    });

    it('tolerates an empty packet', () => {
      const processor = new SignalProcessor();
      expect(processor.process([], channelOrder)).toEqual({
        filtered: [],
        analysis: null,
      });
    });
  });

  describe('live filter control', () => {
    it('reports its current settings', () => {
      const processor = new SignalProcessor({ notch: true });
      expect(processor.settings).toEqual({
        bandpassLow: 8,
        bandpassHigh: 30,
        notch: true,
      });
    });

    it('honours a band chosen at construction', () => {
      const processor = new SignalProcessor({
        bandpassLow: 13,
        bandpassHigh: 30,
      });
      expect(processor.settings.bandpassLow).toBe(13);
    });

    it('turns the notch off mid-stream', () => {
      const processor = new SignalProcessor({ notch: true });
      processor.process(packet(), channelOrder);

      processor.setNotch(false);
      expect(processor.settings.notch).toBe(false);

      // The stream must survive the change.
      expect(
        processor.process(packet(), channelOrder).filtered[0]
      ).toHaveLength(packetSamples);
    });

    it('changes the passband mid-stream', () => {
      const processor = new SignalProcessor();
      processor.process(packet(), channelOrder);

      processor.setBandpass(13, 30);
      expect(processor.settings).toMatchObject({
        bandpassLow: 13,
        bandpassHigh: 30,
      });
    });

    it('rejects a band with no precomputed coefficients', () => {
      const processor = new SignalProcessor();
      expect(() => processor.setBandpass(3, 7)).toThrow();
    });

    it('leaves settings untouched when a band is rejected', () => {
      const processor = new SignalProcessor();
      const before = processor.settings;

      expect(() => processor.setBandpass(3, 7)).toThrow();

      // A rejected change must not half-apply and strand the session on a
      // filter it cannot run.
      expect(processor.settings).toEqual(before);
    });

    it('keeps streaming after a rejected band change', () => {
      const processor = new SignalProcessor();
      processor.process(packet(), channelOrder);

      expect(() => processor.setBandpass(3, 7)).toThrow();

      expect(
        processor.process(packet(), channelOrder).filtered[0]
      ).toHaveLength(packetSamples);
    });

    it('ignores a no-op change', () => {
      const processor = new SignalProcessor({ notch: true });
      processor.setNotch(true);
      expect(processor.settings.notch).toBe(true);
    });
  });

  describe('reset', () => {
    it('drops the epoch buffer so a reused processor starts clean', () => {
      const processor = new SignalProcessor();
      const packetsToFirstEpoch = epochSamples / packetSamples;

      for (let i = 0; i < packetsToFirstEpoch; i++) {
        processor.process(packet(), channelOrder);
      }

      processor.reset();

      expect(processor.process(packet(), channelOrder).analysis).toBeNull();
    });
  });
});
