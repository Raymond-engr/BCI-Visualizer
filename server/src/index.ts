import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';

dotenv.config();

import app from './app';
import connectDB from './db/database';
import validateEnv from './utils/validateEnv';
import SessionManager from './Streaming/services/sessionManager.service';
import {
  uploadConfig,
  classifierConfig,
  logStreamingConfig,
} from './config/streaming';
import logger from './utils/logger';

const PORT = Number(process.env.PORT) || 5000;

/** Create the directories the server writes to, so a fresh clone boots. */
const createDirectories = (): void => {
  const directories = [
    uploadConfig.dir,
    classifierConfig.modelDir,
    path.join(process.cwd(), 'logs'),
  ];

  for (const directory of directories) {
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
      logger.info(`Created directory: ${directory}`);
    }
  }
};

const startServer = async (): Promise<void> => {
  try {
    createDirectories();
    validateEnv();
    logStreamingConfig();

    await connectDB();

    // REST and WebSocket share one HTTP server, so the whole backend is a
    // single port and a single process. Two ports would mean two entries in
    // every deployment config and a second CORS surface for no gain.
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server, path: '/ws/stream' });
    const sessions = new SessionManager(wss);

    server.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`API:       http://localhost:${PORT}/api/v1`);
      logger.info(`Docs:      http://localhost:${PORT}/api-docs`);
      logger.info(`WebSocket: ws://localhost:${PORT}/ws/stream`);
    });

    const shutdown = (signal: string) => {
      logger.info(`${signal} received, shutting down`);
      sessions.shutdown();
      wss.close();
      server.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });

      // A session mid-stream holds the socket open. Do not wait forever.
      setTimeout(() => process.exit(1), 10_000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error: any) {
    logger.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
};

startServer();
