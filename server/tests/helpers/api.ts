import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Response } from 'supertest';
import app from '../../src/app';
import User, { UserRole, IUser } from '../../src/model/user.model';
import tokenService from '../../src/services/token.service';

let mongod: MongoMemoryServer;

export const startTestDb = async (): Promise<void> => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'bci_visualizer_test' });
};

/**
 * Emptying the collections rather than dropping the database preserves the
 * unique index on User.email, which several cases rely on — mongoose only
 * builds indexes when it connects.
 */
export const clearTestDb = async (): Promise<void> => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) =>
      collection.deleteMany({})
    )
  );
};

export const stopTestDb = async (): Promise<void> => {
  await mongoose.disconnect();
  await mongod.stop();
};

export interface SeededUser {
  user: IUser;
  accessToken: string;
}

/**
 * Create a user and mint its access token directly. The auth endpoints are
 * exercised in auth.routes.test.ts; everywhere else logging in over HTTP would
 * only add a bcrypt round-trip and spend the shared /auth rate-limit budget.
 */
export const seedUser = async (
  overrides: Record<string, unknown> = {}
): Promise<SeededUser> => {
  const user = await User.create({
    name: 'Test Researcher',
    email: 'researcher@example.com',
    password: 'password123',
    role: UserRole.RESEARCHER,
    isActive: true,
    ...overrides,
  });

  const { accessToken } = tokenService.generateTokens({
    userId: String(user._id),
    email: user.email,
    role: user.role,
  });

  return { user, accessToken };
};

export const bearer = (token: string): string => `Bearer ${token}`;

/** Collapse a Set-Cookie response header into a Cookie request header. */
export const cookiesFrom = (res: Response): string =>
  (res.headers['set-cookie'] as unknown as string[])
    .map((cookie) => cookie.split(';')[0])
    .join('; ');

export { app };
