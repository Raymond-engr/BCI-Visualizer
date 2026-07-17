/**
 * Test environment.
 *
 * Set before any module is imported, because config/streaming and
 * utils/validateEnv read process.env at module load time — assigning these
 * inside a test body would be too late.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || 'test-access-secret-not-for-production';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-not-for-production';
process.env.MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/bci_visualizer_test';
process.env.LOG_LEVEL = 'error';

jest.setTimeout(20000);
