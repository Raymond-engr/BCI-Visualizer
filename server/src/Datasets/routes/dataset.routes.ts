import { Router } from 'express';
import { z } from 'zod';
import datasetController from '../controllers/dataset.controller';
import { authenticateToken } from '../../middleware/auth.middleware';
import uploadDataset from '../../middleware/uploadDataset';
import validateRequest from '../../middleware/validateRequest';

const router = Router();

const datasetIdSchema = z.object({
  params: z.object({
    datasetId: z
      .string()
      .regex(/^[0-9a-fA-F]{24}$/, 'Invalid dataset ID format'),
  }),
});

router.post(
  '/upload',
  authenticateToken,
  uploadDataset.single('file'),
  datasetController.upload
);

router.get('/', authenticateToken, datasetController.list);

router.get(
  '/:datasetId',
  authenticateToken,
  validateRequest(datasetIdSchema),
  datasetController.getById
);

router.delete(
  '/:datasetId',
  authenticateToken,
  validateRequest(datasetIdSchema),
  datasetController.remove
);

export default router;
