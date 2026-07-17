import { Router } from 'express';
import { z } from 'zod';
import preferenceController from '../controllers/preference.controller';
import { authenticateToken } from '../../middleware/auth.middleware';
import validateRequest from '../../middleware/validateRequest';
import { SessionMode } from '../../Sessions/models/session.model';

const router = Router();

const updatePreferencesSchema = z.object({
  body: z
    .object({
      bandpassLow: z.number().min(0.5).max(100).optional(),
      bandpassHigh: z.number().min(1).max(125).optional(),
      notchEnabled: z.boolean().optional(),
      defaultMode: z.nativeEnum(SessionMode).optional(),
      defaultModelId: z.string().min(1).max(64).optional(),
    })
    .strict(),
});

router.get('/', authenticateToken, preferenceController.get);

router.get('/options', authenticateToken, preferenceController.options);

router.put(
  '/',
  authenticateToken,
  validateRequest(updatePreferencesSchema),
  preferenceController.update
);

export default router;
