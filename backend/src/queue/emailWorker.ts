import { DelayedError, Job, Worker } from 'bullmq';
import { config } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { createRedisConnection, redis } from '../redis/client.js';
import { indexEmailJob } from '../services/elasticsearch.service.js';
import { acquireSendSlot } from '../services/rateLimiter.service.js';
import { notifySlackRateLimit } from '../services/slack.service.js';
import { closeAllTransporters, sendEmailViaSender } from '../services/smtp.service.js';
import { logger } from '../utils/logger.js';
import { emailQueue, enqueueEmailJobsBulk, type EmailJobPayload } from './emailQueue.js';

export async function processEmailJob(
  job: Job<EmailJobPayload>,
  token?: string,
): Promise<{ status: string; messageId?: string; previewUrl?: string | null; reason?: string }> {
  const { emailJobId } = job.data;

  const emailJob = await prisma.emailJob.findUnique({
    where: { id: emailJobId },
    include: { sender: true },
  });

  if (!emailJob) {
    logger.warn({ emailJobId, bullJobId: job.id }, 'EmailJob record missing in PostgreSQL; skipping');
    return { status: 'skipped', reason: 'not_found' };
  }

  // Idempotency guard: never send a job that already succeeded
  if (emailJob.status === 'sent' || emailJob.sentAt !== null) {
    logger.info({ emailJobId }, 'EmailJob already sent; skipping duplicate execution');
    return { status: 'skipped', reason: 'already_sent' };
  }

  if (emailJob.status === 'failed') {
    return { status: 'skipped', reason: 'already_failed' };
  }

  // Check per-sender hourly rate limit & minimum inter-email spacing atomically in Redis
  const slot = await acquireSendSlot(redis, {
    senderId: emailJob.senderId,
    hourlyLimit: emailJob.hourlyLimit ?? config.MAX_EMAILS_PER_HOUR,
    minDelayMs: emailJob.delayBetweenMs ?? config.MIN_DELAY_MS,
  });

  if (slot.status === 'RATE_LIMITED') {
    const rescheduledAt = new Date(slot.targetMs);

    const updated = await prisma.emailJob.update({
      where: { id: emailJob.id },
      data: {
        status: 'rate_limited',
        scheduledAt: rescheduledAt,
        error: `Hourly limit (${emailJob.hourlyLimit ?? config.MAX_EMAILS_PER_HOUR}/hr) reached; rescheduled to ${rescheduledAt.toISOString()}`,
      },
    });

    void indexEmailJob(updated);
    void notifySlackRateLimit({
      userId: emailJob.userId,
      senderId: emailJob.senderId,
      senderEmail: emailJob.sender.email,
      recipient: emailJob.recipient,
      hourlyLimit: emailJob.hourlyLimit ?? config.MAX_EMAILS_PER_HOUR,
      currentHourWindow: slot.hourWindow,
      rescheduledAt,
    });

    logger.info(
      {
        emailJobId: emailJob.id,
        senderId: emailJob.senderId,
        rescheduledAt: rescheduledAt.toISOString(),
        hourCount: slot.hourCount,
      },
      'Hourly rate limit reached; moving job to next available hour window',
    );

    if (token) {
      await job.moveToDelayed(slot.targetMs, token);
      throw new DelayedError();
    }

    await job.changeDelay(Math.max(1000, slot.targetMs - Date.now()));
    return { status: 'rate_limited', reason: 'rescheduled_without_token' };
  }

  if (slot.status === 'SPACING_DELAY') {
    if (token) {
      await job.moveToDelayed(slot.targetMs, token);
      throw new DelayedError();
    }
    await job.changeDelay(Math.max(100, slot.targetMs - Date.now()));
    return { status: 'delayed', reason: 'min_spacing' };
  }

  // Atomic DB claim ensures only one worker can transition scheduled/rate_limited -> processing
  const claimed = await prisma.emailJob.updateMany({
    where: {
      id: emailJob.id,
      status: { in: ['scheduled', 'rate_limited'] },
      sentAt: null,
    },
    data: {
      status: 'processing',
      attempts: { increment: 1 },
      bullJobId: String(job.id ?? emailJob.id),
    },
  });

  if (claimed.count === 0) {
    logger.info({ emailJobId: emailJob.id }, 'EmailJob already claimed or completed by another worker');
    return { status: 'skipped', reason: 'already_claimed' };
  }

  try {
    const sendResult = await sendEmailViaSender({
      sender: emailJob.sender,
      to: emailJob.recipient,
      subject: emailJob.subject,
      body: emailJob.body,
    });

    const sentJob = await prisma.emailJob.update({
      where: { id: emailJob.id },
      data: {
        status: 'sent',
        sentAt: new Date(),
        messageId: sendResult.messageId,
        previewUrl: sendResult.previewUrl,
        error: null,
      },
    });

    await indexEmailJob(sentJob);

    logger.info(
      {
        emailJobId: sentJob.id,
        recipient: sentJob.recipient,
        messageId: sendResult.messageId,
        previewUrl: sendResult.previewUrl,
      },
      'Email sent successfully',
    );

    return {
      status: 'sent',
      messageId: sendResult.messageId,
      previewUrl: sendResult.previewUrl,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown SMTP error';
    const maxAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;

    const updatedJob = await prisma.emailJob.update({
      where: { id: emailJob.id },
      data: {
        status: isFinalAttempt ? 'failed' : 'scheduled',
        error: errorMessage,
      },
    });

    await indexEmailJob(updatedJob);

    logger.error(
      {
        err,
        emailJobId: emailJob.id,
        attempt: job.attemptsMade + 1,
        maxAttempts,
        isFinalAttempt,
      },
      'Email delivery failed',
    );

    throw err;
  }
}

/**
 * Startup reconciliation (non-cron): ensures any pending future jobs or
 * interrupted `processing` jobs in PostgreSQL are present in BullMQ after restarts.
 */
export async function recoverPendingEmailJobs(): Promise<number> {
  const staleCutoff = new Date(Date.now() - 5 * 60 * 1000);

  // Recover jobs that were mid-flight during an unclean worker shutdown
  const resetStale = await prisma.emailJob.updateMany({
    where: {
      status: 'processing',
      sentAt: null,
      updatedAt: { lt: staleCutoff },
    },
    data: {
      status: 'scheduled',
      error: 'Recovered after worker restart',
    },
  });

  if (resetStale.count > 0) {
    logger.warn({ count: resetStale.count }, 'Reset stale processing email jobs back to scheduled');
  }

  const pendingJobs = await prisma.emailJob.findMany({
    where: {
      status: { in: ['scheduled', 'rate_limited'] },
      sentAt: null,
    },
    select: {
      id: true,
      userId: true,
      senderId: true,
      scheduledAt: true,
    },
    orderBy: { scheduledAt: 'asc' },
    take: 5000,
  });

  if (pendingJobs.length === 0) {
    return 0;
  }

  await enqueueEmailJobsBulk(
    pendingJobs.map((j) => ({
      emailJobId: j.id,
      userId: j.userId,
      senderId: j.senderId,
      scheduledAt: j.scheduledAt,
    })),
  );

  logger.info({ recoveredCount: pendingJobs.length }, 'Reconciled pending email jobs with BullMQ');
  return pendingJobs.length;
}

export function startEmailWorker(): Worker<EmailJobPayload> {
  const workerConnection = createRedisConnection('bullmq-worker');

  const worker = new Worker<EmailJobPayload>(
    config.EMAIL_QUEUE_NAME,
    async (job, token) => processEmailJob(job, token),
    {
      connection: workerConnection,
      concurrency: config.WORKER_CONCURRENCY,
      lockDuration: 60000,
    },
  );

  worker.on('ready', () => {
    logger.info(
      {
        queue: config.EMAIL_QUEUE_NAME,
        concurrency: config.WORKER_CONCURRENCY,
        minDelayMs: config.MIN_DELAY_MS,
        maxEmailsPerHour: config.MAX_EMAILS_PER_HOUR,
      },
      'BullMQ email worker ready',
    );
  });

  worker.on('failed', (job, err) => {
    if (err instanceof DelayedError) return;
    logger.error(
      { err, bullJobId: job?.id, emailJobId: job?.data?.emailJobId },
      'BullMQ worker job failed',
    );
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'BullMQ worker error');
  });

  const shutdown = async () => {
    logger.info('Shutting down BullMQ email worker gracefully...');
    await worker.close();
    closeAllTransporters();
    await workerConnection.quit();
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  return worker;
}

export async function getQueueHealthStats() {
  return emailQueue.getJobCounts('wait', 'active', 'delayed', 'completed', 'failed');
}
