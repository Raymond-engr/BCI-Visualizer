import dotenv from 'dotenv';
import {
  cleanEnv,
  str,
  port,
  url,
  email,
  num,
  bool,
  makeValidator,
} from 'envalid';
dotenv.config();

const validateEnv = (): void => {
  const hz = makeValidator((input: string) => {
    const value = Number(input);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid frequency: "${input}"`);
    }
    return value;
  });

  cleanEnv(process.env, {
    NODE_ENV: str({ choices: ['development', 'test', 'production'] }),
    PORT: num({ default: 5000 }),
    MONGODB_URI: url(),
    FRONTEND_URL: url(),
    ALLOWED_ORIGINS: str({ default: '' }),
    API_URL: url(),
    LOG_LEVEL: str({
      choices: ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'],
    }),
    JWT_ACCESS_SECRET: str(),
    JWT_REFRESH_SECRET: str(),
    UPLOADS_DIR: str({ default: 'src/uploads/datasets' }),
    MAX_UPLOAD_MB: num({ default: 50 }),
    MODEL_DIR: str({ default: './models' }),
    DEFAULT_MODEL_ID: str({ default: 'global' }),
    ML_SERVICE_URL: url({ default: 'http://localhost:8000' }),
    USE_ML_SERVICE: bool({ default: false }),
    REFERENCE_DATASET_PATH: str({ default: './models/A01T.gdf' }),
    SAMPLE_RATE: hz({ default: 250 }),
    BANDPASS_LOW: hz({ default: 8 }),
    BANDPASS_HIGH: hz({ default: 30 }),
    NOTCH_FREQ: hz({ default: 50 }),
    ADMIN_NAME: str(),
    ADMIN_EMAIL: email(),
    ADMIN_PASSWORD: str(),
  });
};

export default validateEnv;
