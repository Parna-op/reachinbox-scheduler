import { createApp } from './app.js';
import { config } from './config/env.js';
import { prisma } from './db/prisma.js';
import { recoverPendingEmailJobs, startEmailWorker } from './queue/emailWorker.js';
import { ensureEmailIndex } from './services/elasticsearch.service.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  await prisma.$connect();
  await ensureEmailIndex();
  await recoverPendingEmailJobs();

  if (config.RUN_EMBEDDED_WORKER) {
    startEmailWorker();
    logger.info('Embedded BullMQ worker started inside API server');
  }

  const app = createApp();
  const server = app.listen(config.PORT, () => {
    logger.info(
      {
        port: config.PORT,
        bullBoardUrl: `http://localhost:${config.PORT}/admin/queues`,
      },
      'ReachInbox Scheduler API server listening',
    );
  });

  const shutdown = async () => {
    logger.info('Shutting down API server gracefully...');
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error starting API server');
  process.exit(1);
});
