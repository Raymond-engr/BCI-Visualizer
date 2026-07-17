import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import User, { UserRole } from '../model/user.model';
import connectDB from '../db/database';
import generateSecurePassword from '../utils/passwordGenerator';
import logger from '../utils/logger';

/**
 * Seed the first administrator.
 *
 * Run once after deploying to a fresh database:
 *   npm run create:admin
 *
 * Reads ADMIN_EMAIL / ADMIN_NAME / ADMIN_PASSWORD from the environment. If no
 * password is set, one is generated and printed — it is shown exactly once,
 * since the model hashes it on save.
 */
const createAdmin = async (): Promise<void> => {
  try {
    await connectDB();

    const email = process.env.ADMIN_EMAIL;
    const name = process.env.ADMIN_NAME || 'Administrator';

    if (!email) {
      logger.error('ADMIN_EMAIL is not set');
      process.exit(1);
    }

    const existing = await User.findOne({ email });
    if (existing) {
      logger.warn(`An account already exists for ${email}, nothing to do`);
      await mongoose.connection.close();
      process.exit(0);
    }

    const password = process.env.ADMIN_PASSWORD || generateSecurePassword();

    await User.create({
      name,
      email,
      password,
      role: UserRole.ADMIN,
    });

    logger.info('Administrator created');
    logger.info(`  Email:    ${email}`);

    if (!process.env.ADMIN_PASSWORD) {
      logger.info(`  Password: ${password}`);
      logger.warn('Save this password now. It cannot be recovered.');
    }

    await mongoose.connection.close();
    process.exit(0);
  } catch (error: any) {
    logger.error(`Failed to create administrator: ${error.message}`);
    process.exit(1);
  }
};

createAdmin();
