import { prisma } from './db/prisma.js';
import { ensureEmailIndex } from './services/elasticsearch.service.js';
import { recoverPendingEmailJobs, startEmailWorker } from './queue/emailWorker.js';
import { logger } from './utils/logger.js';

async function bootstrapWorker(): Promise<void> {
  await prisma.$connect();
  await ensureEmailIndex();
  await recoverPendingEmailJobs();
  startEmailWorker();
  logger.info('Dedicated worker process started');
}

bootstrapWorker().catch((err) => {
  logger.error({ err }, 'Fatal error starting email worker');
  process.exit(1);
});
