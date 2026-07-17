import { Request, Response, NextFunction } from 'express';
import { UnauthorizedError, ForbiddenError } from '../utils/customErrors';
import tokenService from '../services/token.service';
import User, { UserRole } from '../model/user.model';

interface UserPayload {
  userId: string;
}

export interface AuthRequest extends Request {
  user?: any;
}

// Authenticate admin access token
const authenticateAdminToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];

    if (!token) {
      throw new UnauthorizedError('Access token required');
    }

    const payload = (await tokenService.verifyAccessToken(
      token
    )) as UserPayload;
    const user = await User.findById(payload.userId);

    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenError('Access denied: Admin privileges required');
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
};

// Authenticate any valid user (admin or researcher)
const authenticateToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];

    if (!token) {
      throw new UnauthorizedError('Access token required');
    }

    const payload = (await tokenService.verifyAccessToken(
      token
    )) as UserPayload;
    const user = await User.findById(payload.userId);

    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    if (!Object.values(UserRole).includes(user.role)) {
      throw new ForbiddenError('Invalid user role');
    }

    if (!user.isActive) {
      throw new UnauthorizedError('Your account is not active');
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * WebSocket connections cannot carry an Authorization header, so the client
 * passes its access token in the INIT frame. This verifies that token and
 * returns the owning user, or throws for the socket handler to translate into
 * a close frame.
 */
const authenticateSocketToken = async (token?: string) => {
  if (!token) {
    throw new UnauthorizedError('Access token required');
  }

  const payload = (await tokenService.verifyAccessToken(token)) as UserPayload;
  const user = await User.findById(payload.userId);

  if (!user) {
    throw new UnauthorizedError('User not found');
  }

  if (!user.isActive) {
    throw new UnauthorizedError('Your account is not active');
  }

  return user;
};

// Rate limiting middleware for public endpoints
const rateLimiter = (limit: number, windowMs: number) => {
  const requests = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const ip = req.ip as string;
      const now = Date.now();

      // Clean old requests
      if (requests.has(ip)) {
        const userRequests = requests.get(ip) || [];
        const validRequests = userRequests.filter(
          (timestamp) => now - timestamp < windowMs
        );

        if (validRequests.length >= limit) {
          throw new UnauthorizedError('Rate limit exceeded');
        }

        requests.set(ip, [...validRequests, now]);
      } else {
        requests.set(ip, [now]);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

export {
  authenticateAdminToken,
  authenticateToken,
  authenticateSocketToken,
  rateLimiter,
};
