import { Router } from 'express';
import authRoutes from './auth.routes';
import datasetRoutes from '../Datasets/routes/dataset.routes';
import sessionRoutes from '../Sessions/routes/session.routes';
import resultsRoutes from '../Sessions/routes/results.routes';
import preferenceRoutes from '../Preferences/routes/preference.routes';
import healthRoutes from './health.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/datasets', datasetRoutes);
router.use('/sessions', sessionRoutes);
router.use('/results', resultsRoutes);
router.use('/preferences', preferenceRoutes);

export default router;
