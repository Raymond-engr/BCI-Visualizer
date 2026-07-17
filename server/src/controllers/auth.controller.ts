import { Request, Response } from 'express';
import User, { UserRole } from '../model/user.model';
import tokenService from '../services/token.service';
import {
  UnauthorizedError,
  DuplicateKeyError,
  BadRequestError,
} from '../utils/customErrors';
import asyncHandler from '../utils/asyncHandler';
import { SuccessResponse } from '../utils/ResponseHelpers';
import logger from '../utils/logger';

interface AuthenticatedRequest extends Request {
  user: {
    _id: string;
    email?: string;
    role: string;
  };
}

class AuthController {
  register = asyncHandler(
    async (req: Request, res: Response): Promise<void> => {
      const { name, email, password, institution } = req.body;
      logger.info(`Registration attempt for email: ${email}`);

      const exists = await User.findOne({ email });
      if (exists) {
        logger.warn(`Registration rejected, email already in use: ${email}`);
        throw new DuplicateKeyError('email', email);
      }

      const user = await User.create({
        name,
        email,
        password,
        institution,
        role: UserRole.RESEARCHER,
        isActive: true,
      });

      const tokens = tokenService.generateTokens({
        userId: String(user._id),
        email: user.email,
        role: user.role,
      });

      user.refreshToken = tokens.refreshToken;
      await user.save();

      tokenService.setRefreshTokenCookie(res, tokens.refreshToken);
      logger.info(`Registration successful for: ${email}`);

      SuccessResponse(res, 'Account created successfully', 201, {
        accessToken: tokens.accessToken,
        user: {
          id: String(user._id),
          name: user.name,
          email: user.email,
          role: user.role,
          institution: user.institution,
        },
      });
    }
  );

  login = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { email, password } = req.body;
    logger.info(`Login attempt for email: ${email}`);

    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      logger.warn(`No account found for email: ${email}`);
      throw new UnauthorizedError('No account found with this email address');
    }

    if (!user.isActive) {
      logger.warn(`Inactive user attempted login: ${email}`);
      throw new UnauthorizedError(
        'Your account is not active. Please contact administrator.'
      );
    }

    const isPasswordCorrect = await user.comparePassword(password);
    if (!isPasswordCorrect) {
      logger.warn(`Incorrect password attempt for: ${email}`);
      throw new UnauthorizedError('Incorrect password');
    }

    const tokens = tokenService.generateTokens({
      userId: String(user._id),
      email: user.email,
      role: user.role,
    });

    user.refreshToken = tokens.refreshToken;
    user.lastLogin = new Date();
    await user.save();

    tokenService.setRefreshTokenCookie(res, tokens.refreshToken);
    logger.info(`Login successful for: ${email}`);

    SuccessResponse(res, 'Logged in successfully', 200, {
      accessToken: tokens.accessToken,
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role,
        institution: user.institution,
      },
    });
  });

  refreshToken = asyncHandler(
    async (req: Request, res: Response): Promise<void> => {
      const token = req.cookies?.refreshToken;
      if (!token) {
        throw new UnauthorizedError('Refresh token required');
      }

      const payload = await tokenService.verifyRefreshToken(token);
      const user = await User.findById(payload.userId).select('+refreshToken');

      if (!user || user.refreshToken !== token) {
        throw new UnauthorizedError('Refresh token has been revoked');
      }

      const tokens = await tokenService.rotateRefreshToken(token, {
        userId: String(user._id),
        email: user.email,
        role: user.role,
      });

      user.refreshToken = tokens.refreshToken;
      await user.save();

      tokenService.setRefreshTokenCookie(res, tokens.refreshToken);

      SuccessResponse(res, 'Token refreshed', 200, {
        accessToken: tokens.accessToken,
      });
    }
  );

  logout = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const token = req.cookies?.refreshToken;

    if (token) {
      const payload = await tokenService.verifyRefreshToken(token);
      await User.findByIdAndUpdate(payload.userId, {
        $unset: { refreshToken: 1 },
      });
      logger.info(`Logout for user: ${payload.email}`);
    }

    tokenService.clearRefreshTokenCookie(res);
    SuccessResponse(res, 'Logged out successfully', 200);
  });

  verifyToken = asyncHandler(async (req: Request, res: Response) => {
    const { user } = req as AuthenticatedRequest;

    if (!user) {
      throw new BadRequestError('No authenticated user on request');
    }

    SuccessResponse(res, 'Token is valid', 200, { user });
  });
}

export default new AuthController();
