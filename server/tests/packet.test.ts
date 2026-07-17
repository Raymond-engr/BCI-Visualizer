import {
  buildDataPacket,
  buildStatus,
  resolveTrueClass,
  CUE_CODES,
} from '../src/Streaming/services/packet.service';
import { MILabel } from '../src/Classification/models/classification.model';

const processed = {
  features: [0.1, 0.2, 0.3, 0.4],
  psd: { freqs: [8, 10, 12], power: [1.234567, 2.345678, 0.987654] },
  topographic: { C3: -1.5, Cz: 0.2, C4: 1.3 },
};

const classification = {
  predictedClass: MILabel.LEFT_HAND,
  confidence: 0.876543,
  allScores: { left_hand: 0.876543, right_hand: 0.09, feet: 0.033457 },
  inferenceMs: 11.2,
  modelId: 'global',
};

describe('packet.service', () => {
  describe('buildDataPacket on an epoch boundary', () => {
    const packet = buildDataPacket({
      samples: [[1.23456, 2.34567]],
      channelNames: ['C3'],
      epochIndex: 7,
      timestamp: 1234.5,
      processed: processed as any,
      classification,
    });

    it('is tagged as a data packet', () => {
      expect(packet.type).toBe('DATA_PACKET');
    });

    it('carries the epoch index through', () => {
      expect(packet.epochIndex).toBe(7);
    });

    it('uses the supplied timestamp', () => {
      expect(packet.timestamp).toBe(1234.5);
    });

    it('rounds samples to three decimals to keep frames small', () => {
      expect(packet.samples[0][0]).toBe(1.235);
    });

    it('rounds confidence to four decimals', () => {
      expect(packet.classification!.confidence).toBe(0.8765);
    });

    it('carries every class score', () => {
      expect(Object.keys(packet.classification!.allScores).sort()).toEqual([
        'feet',
        'left_hand',
        'right_hand',
      ]);
    });

    it('includes the spectrum', () => {
      expect(packet.psd!.freqs).toEqual([8, 10, 12]);
    });

    it('passes the topographic map through unrounded', () => {
      expect(packet.topographic).toEqual(processed.topographic);
    });

    it('preserves channel names', () => {
      expect(packet.channelNames).toEqual(['C3']);
    });
  });

  describe('buildDataPacket between epoch boundaries', () => {
    // This is the common case: 24 of every 25 packets carry only waveform.
    const packet = buildDataPacket({
      samples: [[1.5, 2.5]],
      channelNames: ['C3'],
      epochIndex: 3,
      timestamp: 100,
    });

    it('still carries samples, so the waveform keeps advancing', () => {
      expect(packet.samples[0]).toEqual([1.5, 2.5]);
    });

    it('omits the classification rather than repeating a stale one', () => {
      expect(packet.classification).toBeUndefined();
      expect('classification' in packet).toBe(false);
    });

    it('omits the spectrum', () => {
      expect(packet.psd).toBeUndefined();
    });

    it('omits the topographic map', () => {
      expect(packet.topographic).toBeUndefined();
    });

    it('reports the last completed epoch so the client can hold its badge', () => {
      expect(packet.epochIndex).toBe(3);
    });

    it('accepts -1 before any epoch has completed', () => {
      const first = buildDataPacket({
        samples: [[0]],
        channelNames: ['C3'],
        epochIndex: -1,
      });
      expect(first.epochIndex).toBe(-1);
    });

    it('is materially smaller than a full packet', () => {
      const full = buildDataPacket({
        samples: [[1.5, 2.5]],
        channelNames: ['C3'],
        epochIndex: 3,
        timestamp: 100,
        processed: processed as any,
        classification,
      });
      expect(JSON.stringify(packet).length).toBeLessThan(
        JSON.stringify(full).length
      );
    });
  });

  it('falls back to wall-clock time when no timestamp is supplied', () => {
    const now = buildDataPacket({
      samples: [[1]],
      channelNames: ['C3'],
      epochIndex: 0,
    });
    expect(now.timestamp).toBeGreaterThan(1_600_000_000);
  });

  describe('buildStatus', () => {
    it('builds a STARTED frame', () => {
      const status = buildStatus('STARTED', 'Session started', 'abc');
      expect(status.status).toBe('STARTED');
      expect(status.sessionId).toBe('abc');
    });

    it('allows an omitted session id', () => {
      expect(buildStatus('ERROR', 'boom').sessionId).toBeUndefined();
    });

    it('carries the stream config on STARTED', () => {
      const config = {
        mode: 'simulation',
        sampleRate: 250,
        channelNames: ['C3', 'Cz', 'C4'],
        packetSamples: 10,
        epochSamples: 1000,
        stepSamples: 250,
        speed: 1,
        labels: ['left_hand', 'right_hand', 'feet'],
        filters: { bandpassLow: 8, bandpassHigh: 30, notch: true },
        hasGroundTruth: true,
      };
      const status = buildStatus('STARTED', 'go', 'abc', { config });
      expect(status.config).toEqual(config);
    });

    it('echoes the live filter settings on APPLIED', () => {
      const filters = { bandpassLow: 13, bandpassHigh: 30, notch: false };
      const status = buildStatus('APPLIED', 'updated', undefined, { filters });
      expect(status.status).toBe('APPLIED');
      expect(status.filters).toEqual(filters);
    });
  });

  describe('CUE_CODES', () => {
    it('maps the three trained classes', () => {
      expect(CUE_CODES[769]).toBe(MILabel.LEFT_HAND);
      expect(CUE_CODES[770]).toBe(MILabel.RIGHT_HAND);
      expect(CUE_CODES[771]).toBe(MILabel.FEET);
    });

    it('does not map the tongue cue, which the model is not trained on', () => {
      expect(CUE_CODES[772]).toBeUndefined();
    });
  });

  describe('resolveTrueClass', () => {
    const events = [
      { position: 250, typeCode: 769 },
      { position: 2000, typeCode: 770 },
      { position: 4000, typeCode: 772 },
    ];

    it('labels an epoch inside a trial with that trial cue', () => {
      expect(resolveTrueClass(events, 500, 250)).toBe(MILabel.LEFT_HAND);
    });

    it('labels an epoch inside a later trial with the later cue', () => {
      expect(resolveTrueClass(events, 2500, 250)).toBe(MILabel.RIGHT_HAND);
    });

    it('returns undefined once the trial window has elapsed', () => {
      // 250 + 4 s * 250 Hz = 1250, so 1500 is past the trial.
      expect(resolveTrueClass(events, 1500, 250)).toBeUndefined();
    });

    it('returns undefined before any cue', () => {
      expect(resolveTrueClass(events, 100, 250)).toBeUndefined();
    });

    it('returns undefined during a tongue trial rather than guessing', () => {
      expect(resolveTrueClass(events, 4200, 250)).toBeUndefined();
    });

    it('honours a custom trial length', () => {
      expect(resolveTrueClass(events, 500, 250, 0.5)).toBeUndefined();
    });
  });
});
