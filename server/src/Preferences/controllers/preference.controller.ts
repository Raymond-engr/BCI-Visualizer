import { Response } from 'express';
import Preference from '../models/preference.model';
import asyncHandler from '../../utils/asyncHandler';
import { SuccessResponse } from '../../utils/ResponseHelpers';
import { BadRequestError } from '../../utils/customErrors';
import { BANDPASS_TABLE } from '../../Signal_Processing/services/filters.service';
import { streamingConfig, filterConfig } from '../../config/streaming';
import logger from '../../utils/logger';
import type { AuthRequest } from '../../middleware/auth.middleware';

class PreferenceController {
  /**
   * GET /preferences
   * Returns the user's settings, creating defaults on first read so the
   * settings page never has to handle a null state.
   */
  get = asyncHandler(async (req: AuthRequest, res: Response) => {
    const preferences = await Preference.findOneAndUpdate(
      { userId: req.user._id },
      { $setOnInsert: { userId: req.user._id } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    SuccessResponse(
      res,
      'Preferences retrieved successfully',
      200,
      preferences
    );
  });

  /**
   * PUT /preferences
   */
  update = asyncHandler(async (req: AuthRequest, res: Response) => {
    // Both cutoffs are optional, so this is a partial update. What has to be
    // filterable is the band the stored document ends up forming, not the
    // fragment of it this request happens to carry — validating only the
    // request would let a lone cutoff pair with the stored other half into a
    // band that has no coefficients.
    const existing = await Preference.findOneAndUpdate(
      { userId: req.user._id },
      { $setOnInsert: { userId: req.user._id } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const bandpassLow = req.body.bandpassLow ?? existing.bandpassLow;
    const bandpassHigh = req.body.bandpassHigh ?? existing.bandpassHigh;

    if (bandpassLow >= bandpassHigh) {
      throw new BadRequestError(
        'Bandpass lower cutoff must be below the upper cutoff'
      );
    }

    // Filter coefficients are precomputed offline, so an arbitrary band cannot
    // be honoured at runtime. Rejecting it here gives the user a clear message
    // instead of a 500 on the next epoch.
    const key = `${bandpassLow}-${bandpassHigh}@${streamingConfig.sampleRate}`;

    if (!BANDPASS_TABLE[key]) {
      throw new BadRequestError(
        `No filter is available for ${bandpassLow}-${bandpassHigh} Hz. ` +
          `Supported bands: ${Object.keys(BANDPASS_TABLE)
            .map((k) => k.split('@')[0].replace('-', '–') + ' Hz')
            .join(', ')}.`
      );
    }

    const preferences = await Preference.findOneAndUpdate(
      { userId: req.user._id },
      { ...req.body, userId: req.user._id, updatedAt: new Date() },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      }
    );

    logger.info(`Preferences updated for ${req.user.email}`);

    SuccessResponse(res, 'Preferences updated successfully', 200, preferences);
  });

  /**
   * GET /preferences/options
   * The filter bands this deployment actually has coefficients for, so the
   * settings page can offer a select rather than a free-text field that would
   * mostly produce rejections.
   *
   * Also reports the fixed pipeline constants the settings page displays. They
   * are not preferences — nothing can change them at runtime — but they are
   * derived from SAMPLE_RATE, so a deployment running at another rate would
   * otherwise leave the page quoting numbers that were never true.
   */
  options = asyncHandler(async (_req: AuthRequest, res: Response) => {
    SuccessResponse(res, 'Options retrieved successfully', 200, {
      sampleRate: streamingConfig.sampleRate,
      epochSeconds: streamingConfig.epochSamples / streamingConfig.sampleRate,
      notchFreq: filterConfig.notchFreq,
      bandpassOptions: Object.keys(BANDPASS_TABLE).map((key) => {
        const [range] = key.split('@');
        const [low, high] = range.split('-').map(Number);
        return { low, high, label: `${low}–${high} Hz` };
      }),
    });
  });
}

export default new PreferenceController();
