import type { CorsOptions } from 'cors';
import type { HelmetOptions } from 'helmet';

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = [
      ...(process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()),
      process.env.FRONTEND_URL,
    ].filter(Boolean);

    if (
      !origin ||
      allowedOrigins.includes(origin) ||
      allowedOrigins.includes('*')
    ) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  credentials: true,
  optionsSuccessStatus: 200,
  allowedHeaders: ['Content-Type', 'Authorization'],
};

export const helmetOptions: HelmetOptions = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      upgradeInsecureRequests: [],
    },
  },
  referrerPolicy: {
    policy: 'strict-origin-when-cross-origin',
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  noSniff: true,
  xssFilter: true,
  hidePoweredBy: true,
  frameguard: {
    action: 'deny',
  },
};

export const rateLimitOptions = {
  windowMs: 15 * 60 * 1000,
  max: 9000,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again later.',
  statusCode: 429,
  skipFailedRequests: false,
  skipSuccessfulRequests: false,
  limit: 9000,
  requestPropertyName: 'rateLimit',
};
