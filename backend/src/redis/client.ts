import Redis from 'ioredis';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

export function createRedisConnection(name = 'default'): Redis {
  const client = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    retryStrategy(times) {
      return Math.min(times * 200, 3000);
    },
  });

  client.on('error', (err) => {
    logger.error({ err, redisClient: name }, 'Redis connection error');
  });

  client.on('connect', () => {
    logger.info({ redisClient: name }, 'Redis connected');
  });

  return client;
}

export const redis = createRedisConnection('app');
