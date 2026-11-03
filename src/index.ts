import http from 'http';
import { config } from './config/env';
import { logger } from './config/logger';
import { connectDatabase, disconnectDatabase } from './database';
import { setupQueue, isRedisQueueActive } from './queues/queue';
import { setupWorker, bullWorker } from './queues/worker';
import { initializeTools } from './ai/tools';
import {
  startReminderScheduler,
  stopReminderScheduler,
} from './ai/tools/schedulerTools';
import { initBot, stopBot, isBotRunning } from './telegram/bot';
import { initUserbot, disconnectUserbot, isUserbotConnected } from './telegram/userbot';
import { registerUserbotListeners } from './telegram/userbot/listener';
import { createExpressApp } from './server/app';

let server: http.Server | null = null;
let isShuttingDown = false;

async function bootstrap() {
  logger.info('====================================================');
  logger.info('  Starting Autonomous Telegram AI Agent & Userbot   ');
  logger.info(`  Environment: ${config.NODE_ENV} | Port: ${config.PORT}`);
  logger.info('====================================================');

  // 1. Initialize Tools
  initializeTools();

  // 2. Connect to Database (MongoDB)
  await connectDatabase();

  // 3. Setup Queue and Background Worker
  await setupQueue();
  setupWorker();

  // 4. Start Express HTTP Server
  const app = createExpressApp(
    () => isBotRunning(),
    () => isUserbotConnected(),
    () => isRedisQueueActive || true
  );

  server = app.listen(config.PORT, () => {
    logger.info(`HTTP Server running at http://localhost:${config.PORT}`);
    logger.info(`Health check available at http://localhost:${config.PORT}/health`);
  });

  // 5. Initialize Telegram Bot
  await initBot();

  // 6. Initialize Telegram Userbot
  const userbotClient = await initUserbot();
  if (userbotClient && isUserbotConnected()) {
    registerUserbotListeners(userbotClient);
  }

  // 7. Start the reminder poller (agent can act in the future, not just react)
  startReminderScheduler();

  logger.info('System startup complete. Ready to process events.');
}

// Graceful Shutdown
async function handleShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`Received ${signal}. Initiating graceful shutdown...`);

  // Stop accepting new HTTP requests
  if (server) {
    await new Promise<void>((resolve) => {
      server?.close(() => {
        logger.info('HTTP server closed.');
        resolve();
      });
    });
  }

  // Stop the reminder poller
  stopReminderScheduler();

  // Stop Telegram Bot
  await stopBot();

  // Disconnect Userbot
  await disconnectUserbot();

  // Close BullMQ worker
  if (bullWorker) {
    await bullWorker.close();
    logger.info('BullMQ worker closed.');
  }

  // Disconnect Database
  await disconnectDatabase();

  logger.info('Graceful shutdown completed successfully.');
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection:', reason);
});

bootstrap().catch((err) => {
  logger.error('Fatal error during startup bootstrap:', err);
  process.exit(1);
});
