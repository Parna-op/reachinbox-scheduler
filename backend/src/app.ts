import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { config } from './config/env.js';
import { prisma } from './db/prisma.js';
import { emailQueue } from './queue/emailQueue.js';
import { redis } from './redis/client.js';
import { authRouter } from './routes/auth.routes.js';
import { emailsRouter } from './routes/emails.routes.js';
import { sendersRouter } from './routes/senders.routes.js';
import { slackRouter } from './routes/slack.routes.js';
import { esClient } from './services/elasticsearch.service.js';
import { logger } from './utils/logger.js';

export function createApp() {
  const app = express();

  app.use(
    helmet({
      contentSecurityPolicy: false, // Allows Bull Board inline UI assets at /admin/queues
    }),
  );

  app.use(
    cors({
      origin: config.FRONTEND_URL,
      credentials: true,
    }),
  );

  app.use(cookieParser());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Bull Board queue dashboard at /admin/queues
  const bullBoardAdapter = new ExpressAdapter();
  bullBoardAdapter.setBasePath('/admin/queues');
  createBullBoard({
    queues: [new BullMQAdapter(emailQueue)],
    serverAdapter: bullBoardAdapter,
  });
  app.use('/admin/queues', bullBoardAdapter.getRouter());

  app.get('/api/health', async (_req, res) => {
    const checks = {
      postgres: false,
      redis: false,
      elasticsearch: false,
    };

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.postgres = true;
    } catch {
      checks.postgres = false;
    }

    try {
      const pong = await redis.ping();
      checks.redis = pong === 'PONG';
    } catch {
      checks.redis = false;
    }

    try {
      await esClient.ping();
      checks.elasticsearch = true;
    } catch {
      checks.elasticsearch = false;
    }

    const healthy = checks.postgres && checks.redis;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/slack', slackRouter);
  app.use('/api/senders', sendersRouter);
  app.use('/api/emails', emailsRouter);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'Unhandled Express error');
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message });
  });

  return app;
}
