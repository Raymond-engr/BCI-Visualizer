import { Response } from 'express';
import Session, { SessionMode, SessionStatus } from '../models/session.model';
import Classification from '../../Classification/models/classification.model';
import Dataset, { DatasetStatus } from '../../Datasets/models/dataset.model';
import asyncHandler from '../../utils/asyncHandler';
import { SuccessResponse } from '../../utils/ResponseHelpers';
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} from '../../utils/customErrors';
import logger from '../../utils/logger';
import type { AuthRequest } from '../../middleware/auth.middleware';

class SessionController {
  /**
   * POST /sessions
   * Reserves a session document. The client then opens a WebSocket and sends
   * the returned id in its INIT frame — creating the record over REST first
   * means an aborted socket still leaves a session the user can see and clean
   * up, rather than a silent no-op.
   */
  create = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { mode, datasetId, modelId } = req.body;

    if (mode === SessionMode.UPLOAD) {
      if (!datasetId) {
        throw new BadRequestError('Upload sessions require a datasetId');
      }

      const dataset = await Dataset.findById(datasetId);
      if (!dataset) {
        throw new NotFoundError('Dataset not found');
      }
      if (String(dataset.userId) !== String(req.user._id)) {
        throw new ForbiddenError('This dataset belongs to another user');
      }
      if (dataset.status !== DatasetStatus.PARSED) {
        throw new BadRequestError(
          `Dataset is not usable (status: ${dataset.status})`
        );
      }
    }

    const session = await Session.create({
      userId: req.user._id,
      datasetId: mode === SessionMode.UPLOAD ? datasetId : undefined,
      mode,
      modelId: modelId || 'global',
      status: SessionStatus.PENDING,
    });

    logger.info(
      `Session ${session._id} created in ${mode} mode by ${req.user.email}`
    );

    SuccessResponse(res, 'Session created successfully', 201, session);
  });

  /**
   * GET /sessions
   * Session history for the authenticated user, newest first.
   */
  list = asyncHandler(async (req: AuthRequest, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const filter: Record<string, unknown> = { userId: req.user._id };
    if (req.query.mode) filter.mode = req.query.mode;
    if (req.query.status) filter.status = req.query.status;

    const [sessions, total] = await Promise.all([
      Session.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('datasetId', 'originalName format durationSeconds'),
      Session.countDocuments(filter),
    ]);

    SuccessResponse(res, 'Sessions retrieved successfully', 200, {
      sessions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  });

  /**
   * GET /sessions/:sessionId
   * A session with its per-class breakdown, which is what the expanded history
   * card renders.
   */
  getById = asyncHandler(async (req: AuthRequest, res: Response) => {
    const session = await Session.findById(req.params.sessionId).populate(
      'datasetId',
      'originalName format durationSeconds channelNames sampleRate'
    );

    if (!session) {
      throw new NotFoundError('Session not found');
    }
    if (String(session.userId) !== String(req.user._id)) {
      throw new ForbiddenError('This session belongs to another user');
    }

    // Aggregate in Mongo rather than pulling thousands of epoch documents into
    // Node just to count them.
    const breakdown = await Classification.aggregate([
      { $match: { sessionId: session._id } },
      {
        $group: {
          _id: '$predictedClass',
          count: { $sum: 1 },
          meanConfidence: { $avg: '$confidence' },
        },
      },
      { $sort: { count: -1 } },
    ]);

    SuccessResponse(res, 'Session retrieved successfully', 200, {
      session,
      breakdown,
    });
  });

  /**
   * GET /sessions/:sessionId/classifications
   * The raw epoch-by-epoch log.
   */
  getClassifications = asyncHandler(async (req: AuthRequest, res: Response) => {
    const session = await Session.findById(req.params.sessionId);

    if (!session) {
      throw new NotFoundError('Session not found');
    }
    if (String(session.userId) !== String(req.user._id)) {
      throw new ForbiddenError('This session belongs to another user');
    }

    const classifications = await Classification.find({
      sessionId: session._id,
    })
      .sort({ epochIndex: 1 })
      .select('-features');

    SuccessResponse(
      res,
      'Classifications retrieved successfully',
      200,
      classifications
    );
  });

  /**
   * DELETE /sessions/:sessionId
   * Removes the session and every epoch recorded under it.
   */
  remove = asyncHandler(async (req: AuthRequest, res: Response) => {
    const session = await Session.findById(req.params.sessionId);

    if (!session) {
      throw new NotFoundError('Session not found');
    }
    if (String(session.userId) !== String(req.user._id)) {
      throw new ForbiddenError('This session belongs to another user');
    }

    await Classification.deleteMany({ sessionId: session._id });
    await session.deleteOne();

    logger.info(`Session ${session._id} deleted by ${req.user.email}`);

    SuccessResponse(res, 'Session deleted successfully', 200);
  });
}

export default new SessionController();
