import os from 'os';
import path from 'path';

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

/**
 * services/token.service calls validateEnv() at module load, so importing the
 * app pulls the whole envalid schema in. These have no default there and would
 * abort the process; the values themselves are never asserted on.
 */
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3001';
process.env.API_URL = process.env.API_URL || 'http://localhost:5000';
process.env.ADMIN_NAME = process.env.ADMIN_NAME || 'Test Admin';
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin-pass';

// Multer resolves its destination once, at module load. Keep uploaded fixtures
// out of the source tree.
process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'bci-test-uploads');

jest.setTimeout(20000);
