import { Router } from 'express';
import { z } from 'zod';
import sessionController from '../controllers/session.controller';
import { authenticateToken } from '../../middleware/auth.middleware';
import validateRequest from '../../middleware/validateRequest';
import { SessionMode, SessionStatus } from '../models/session.model';

const router = Router();

const objectId = (label: string) =>
  z.string().regex(/^[0-9a-fA-F]{24}$/, `Invalid ${label} format`);

const createSessionSchema = z.object({
  body: z.object({
    mode: z.nativeEnum(SessionMode),
    datasetId: objectId('dataset ID').optional(),
    modelId: z.string().optional(),
  }),
});

const listSessionsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    mode: z.nativeEnum(SessionMode).optional(),
    status: z.nativeEnum(SessionStatus).optional(),
  }),
});

const sessionIdSchema = z.object({
  params: z.object({
    sessionId: objectId('session ID'),
  }),
});

router.post(
  '/',
  authenticateToken,
  validateRequest(createSessionSchema),
  sessionController.create
);

router.get(
  '/',
  authenticateToken,
  validateRequest(listSessionsSchema),
  sessionController.list
);

router.get(
  '/:sessionId',
  authenticateToken,
  validateRequest(sessionIdSchema),
  sessionController.getById
);

router.get(
  '/:sessionId/classifications',
  authenticateToken,
  validateRequest(sessionIdSchema),
  sessionController.getClassifications
);

router.delete(
  '/:sessionId',
  authenticateToken,
  validateRequest(sessionIdSchema),
  sessionController.remove
);

export default router;
