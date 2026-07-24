import { Response } from 'express';
import fs from 'fs';
import path from 'path';
import Dataset, { DatasetFormat, DatasetStatus } from '../models/dataset.model';
import {
  loadRecording,
  alignToMontage,
} from '../services/datasetLoader.service';
import asyncHandler from '../../utils/asyncHandler';
import { SuccessResponse } from '../../utils/ResponseHelpers';
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} from '../../utils/customErrors';
import logger from '../../utils/logger';
import type { AuthRequest } from '../../middleware/auth.middleware';

class DatasetController {
  /**
   * POST /datasets/upload
   * Accepts a GDF or CSV recording, parses it synchronously so the user gets
   * immediate feedback on an unusable file, and records the metadata the
   * dashboard needs before a session can start.
   */
  upload = asyncHandler(async (req: AuthRequest, res: Response) => {
    const file = req.file;
    if (!file) {
      throw new BadRequestError('No file was uploaded');
    }

    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    const dataset = await Dataset.create({
      userId: req.user._id,
      originalName: file.originalname,
      storedName: file.filename,
      filePath: file.path,
      format: ext as DatasetFormat,
      sizeBytes: file.size,
      status: DatasetStatus.UPLOADED,
      subjectId: req.body.subjectId,
    });

    logger.info(
      `Dataset uploaded: ${file.originalname} (${file.size} bytes) by ${req.user.email}`
    );

    try {
      const recording = loadRecording(file.path);
      const aligned = alignToMontage(recording);

      dataset.status = DatasetStatus.PARSED;
      dataset.channelCount = aligned.channelNames.length;
      dataset.channelNames = aligned.channelNames;
      dataset.sampleRate = aligned.sampleRate;
      dataset.sampleCount = aligned.samples[0].length;
      dataset.durationSeconds = recording.durationSeconds;
      dataset.eventCount = recording.events.length;
      await dataset.save();
    } catch (error: any) {
      // A file that parses badly is still worth keeping so the user can see
      // why it was rejected, but it must not be selectable for a session.
      dataset.status = DatasetStatus.INVALID;
      dataset.parseError = error.message;
      await dataset.save();

      logger.warn(`Dataset ${dataset._id} failed to parse: ${error.message}`);
      throw new BadRequestError(
        `Recording could not be read: ${error.message}`
      );
    }

    // filePath is an absolute path on the server and is stripped from every
    // read route; echoing it back here would leak it on the one response that
    // is guaranteed to reach the client.
    const { filePath: _filePath, ...created } = dataset.toObject();

    SuccessResponse(res, 'Dataset uploaded successfully', 201, created);
  });

  /**
   * GET /datasets
   * Lists the authenticated user's uploads, newest first.
   */
  list = asyncHandler(async (req: AuthRequest, res: Response) => {
    const datasets = await Dataset.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .select('-filePath');

    SuccessResponse(res, 'Datasets retrieved successfully', 200, datasets);
  });

  /**
   * GET /datasets/:datasetId
   */
  getById = asyncHandler(async (req: AuthRequest, res: Response) => {
    const dataset = await Dataset.findById(req.params.datasetId).select(
      '-filePath'
    );

    if (!dataset) {
      throw new NotFoundError('Dataset not found');
    }

    if (String(dataset.userId) !== String(req.user._id)) {
      throw new ForbiddenError('This dataset belongs to another user');
    }

    SuccessResponse(res, 'Dataset retrieved successfully', 200, dataset);
  });

  /**
   * DELETE /datasets/:datasetId
   * Removes the document and the file backing it.
   */
  remove = asyncHandler(async (req: AuthRequest, res: Response) => {
    const dataset = await Dataset.findById(req.params.datasetId);

    if (!dataset) {
      throw new NotFoundError('Dataset not found');
    }

    if (String(dataset.userId) !== String(req.user._id)) {
      throw new ForbiddenError('This dataset belongs to another user');
    }

    if (fs.existsSync(dataset.filePath)) {
      fs.unlinkSync(dataset.filePath);
    }

    await dataset.deleteOne();
    logger.info(
      `Dataset deleted: ${dataset.originalName} by ${req.user.email}`
    );

    SuccessResponse(res, 'Dataset deleted successfully', 200);
  });
}

export default new DatasetController();
