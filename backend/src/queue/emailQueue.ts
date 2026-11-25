import { Queue } from 'bullmq';
import { config } from '../config/env.js';
import { createRedisConnection } from '../redis/client.js';

export interface EmailJobPayload {
  emailJobId: string;
  userId: string;
  senderId: string;
}

export const queueRedisConnection = createRedisConnection('bullmq-queue');

export const emailQueue = new Queue<EmailJobPayload>(config.EMAIL_QUEUE_NAME, {
  connection: queueRedisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: {
      age: 60 * 60 * 24, // Keep completed jobs 24h for Bull Board visibility
      count: 5000,
    },
    removeOnFail: {
      age: 60 * 60 * 24 * 7, // Keep failed jobs 7d
      count: 5000,
    },
  },
});

export async function enqueueEmailJobsBulk(
  jobs: Array<{
    emailJobId: string;
    userId: string;
    senderId: string;
    scheduledAt: Date;
  }>,
): Promise<void> {
  const now = Date.now();
  const chunkSize = 500;

  for (let i = 0; i < jobs.length; i += chunkSize) {
    const slice = jobs.slice(i, i + chunkSize);
    await emailQueue.addBulk(
      slice.map((item) => ({
        name: 'send-email',
        data: {
          emailJobId: item.emailJobId,
          userId: item.userId,
          senderId: item.senderId,
        },
        opts: {
          jobId: item.emailJobId, // Deterministic ID guarantees queue-level idempotency
          delay: Math.max(0, item.scheduledAt.getTime() - now),
        },
      })),
    );
  }
}
