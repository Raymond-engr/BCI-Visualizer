import { Router } from 'express';
import { z } from 'zod';
import authController from '../controllers/auth.controller';
import { rateLimiter, authenticateToken } from '../middleware/auth.middleware';
import validateRequest from '../middleware/validateRequest';

const router = Router();

const standardLimit = rateLimiter(20, 60 * 60 * 1000);

const registerSchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    institution: z.string().optional(),
  }),
});

const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required'),
  }),
});

router.post(
  '/register',
  standardLimit,
  validateRequest(registerSchema),
  authController.register
);
router.post(
  '/login',
  standardLimit,
  validateRequest(loginSchema),
  authController.login
);
router.post('/refresh-token', standardLimit, authController.refreshToken);
router.post('/logout', authController.logout);

// Token verification route - protected by auth middleware
router.get('/verify-token', authenticateToken, authController.verifyToken);

export default router;
