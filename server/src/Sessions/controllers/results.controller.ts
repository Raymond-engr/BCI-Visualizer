import { Response } from 'express';
import Session from '../models/session.model';
import Classification from '../../Classification/models/classification.model';
import asyncHandler from '../../utils/asyncHandler';
import { SuccessResponse } from '../../utils/ResponseHelpers';
import { NotFoundError, ForbiddenError } from '../../utils/customErrors';
import logger from '../../utils/logger';
import type { AuthRequest } from '../../middleware/auth.middleware';

const CSV_COLUMNS = [
  'epoch_index',
  'timestamp',
  'predicted_class',
  'confidence',
  'left_hand',
  'right_hand',
  'feet',
  'true_class',
  'inference_ms',
];

/** Escape a CSV field per RFC 4180. */
const escape = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

class ResultsController {
  /**
   * GET /results/:sessionId/export
   * Streams the session's classification log as CSV.
   */
  exportCSV = asyncHandler(async (req: AuthRequest, res: Response) => {
    const session = await Session.findById(req.params.sessionId).populate(
      'datasetId',
      'originalName'
    );

    if (!session) {
      throw new NotFoundError('Session not found');
    }
    if (String(session.userId) !== String(req.user._id)) {
      throw new ForbiddenError('This session belongs to another user');
    }

    const filename = `session-${session._id}-${
      session.startTime.toISOString().split('T')[0]
    }.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    res.write(`${CSV_COLUMNS.join(',')}\n`);

    // A long session holds thousands of epochs. Cursor over them and write as
    // they arrive so memory stays flat regardless of session length.
    const cursor = Classification.find({ sessionId: session._id })
      .sort({ epochIndex: 1 })
      .lean()
      .cursor();

    for await (const row of cursor) {
      const scores = (row.allScores ?? {}) as Record<string, number>;
      res.write(
        [
          row.epochIndex,
          row.epochTimestamp,
          row.predictedClass,
          row.confidence?.toFixed(4),
          scores.left_hand?.toFixed(4) ?? '',
          scores.right_hand?.toFixed(4) ?? '',
          scores.feet?.toFixed(4) ?? '',
          row.trueClass ?? '',
          row.inferenceMs ?? '',
        ]
          .map(escape)
          .join(',') + '\n'
      );
    }

    logger.info(`Exported session ${session._id} for ${req.user.email}`);
    res.end();
  });

  /**
   * GET /results/:sessionId/summary
   * Aggregate statistics for a single session.
   */
  summary = asyncHandler(async (req: AuthRequest, res: Response) => {
    const session = await Session.findById(req.params.sessionId);

    if (!session) {
      throw new NotFoundError('Session not found');
    }
    if (String(session.userId) !== String(req.user._id)) {
      throw new ForbiddenError('This session belongs to another user');
    }

    const [stats] = await Classification.aggregate([
      { $match: { sessionId: session._id } },
      {
        $group: {
          _id: null,
          epochs: { $sum: 1 },
          meanConfidence: { $avg: '$confidence' },
          meanInferenceMs: { $avg: '$inferenceMs' },
          correct: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$trueClass', null] },
                    { $eq: ['$trueClass', '$predictedClass'] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          labelled: {
            $sum: { $cond: [{ $ne: ['$trueClass', null] }, 1, 0] },
          },
        },
      },
    ]);

    const breakdown = await Classification.aggregate([
      { $match: { sessionId: session._id } },
      { $group: { _id: '$predictedClass', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    SuccessResponse(res, 'Summary retrieved successfully', 200, {
      sessionId: session._id,
      mode: session.mode,
      status: session.status,
      startTime: session.startTime,
      endTime: session.endTime,
      durationSeconds: session.durationSeconds,
      epochs: stats?.epochs ?? 0,
      meanConfidence: stats?.meanConfidence ?? null,
      meanInferenceMs: stats?.meanInferenceMs ?? null,
      // Accuracy is only meaningful against cue events; a simulation of an
      // unlabelled recording legitimately has none.
      accuracy: stats?.labelled ? stats.correct / stats.labelled : null,
      labelledEpochs: stats?.labelled ?? 0,
      breakdown,
    });
  });
}

export default new ResultsController();
