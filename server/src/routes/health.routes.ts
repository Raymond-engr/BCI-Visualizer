import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import asyncHandler from '../utils/asyncHandler';
import { SuccessResponse } from '../utils/ResponseHelpers';
import { getClassifier } from '../Classification/services/mlServiceClient.service';
import { classifierConfig, streamingConfig } from '../config/streaming';

const router = Router();

/**
 * GET /health
 * Liveness and dependency status. Deliberately unauthenticated so a load
 * balancer or uptime monitor can reach it.
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const dbStates = [
      'disconnected',
      'connected',
      'connecting',
      'disconnecting',
    ];

    SuccessResponse(res, 'Service healthy', 200, {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      database: dbStates[mongoose.connection.readyState] ?? 'unknown',
      classifier: {
        backend: classifierConfig.useMLService ? 'ml-service' : 'onnx',
        modelsLoaded: getClassifier().loadedModels,
      },
      streaming: {
        sampleRate: streamingConfig.sampleRate,
        epochSamples: streamingConfig.epochSamples,
        stepSamples: streamingConfig.stepSamples,
      },
      timestamp: new Date().toISOString(),
    });
  })
);

export default router;
