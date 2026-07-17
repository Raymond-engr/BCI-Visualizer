import { Router } from 'express';
import { z } from 'zod';
import resultsController from '../controllers/results.controller';
import { authenticateToken } from '../../middleware/auth.middleware';
import validateRequest from '../../middleware/validateRequest';

const router = Router();

const sessionIdSchema = z.object({
  params: z.object({
    sessionId: z
      .string()
      .regex(/^[0-9a-fA-F]{24}$/, 'Invalid session ID format'),
  }),
});

router.get(
  '/:sessionId/export',
  authenticateToken,
  validateRequest(sessionIdSchema),
  resultsController.exportCSV
);

router.get(
  '/:sessionId/summary',
  authenticateToken,
  validateRequest(sessionIdSchema),
  resultsController.summary
);

export default router;
