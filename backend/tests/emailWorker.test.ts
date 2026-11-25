import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DelayedError } from 'bullmq';

const mockPrisma = vi.hoisted(() => ({
  emailJob: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  slackIntegration: {
    findUnique: vi.fn(),
  },
}));

const mockAcquireSendSlot = vi.hoisted(() => vi.fn());
const mockSendEmailViaSender = vi.hoisted(() => vi.fn());
const mockNotifySlack = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockIndexEmailJob = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../src/db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../src/redis/client.js', () => ({
  redis: { set: vi.fn(), eval: vi.fn(), ping: vi.fn() },
  createRedisConnection: vi.fn(() => ({ on: vi.fn(), quit: vi.fn() })),
}));
vi.mock('../src/services/rateLimiter.service.js', () => ({
  acquireSendSlot: mockAcquireSendSlot,
}));
vi.mock('../src/services/smtp.service.js', () => ({
  sendEmailViaSender: mockSendEmailViaSender,
  closeAllTransporters: vi.fn(),
}));
vi.mock('../src/services/slack.service.js', () => ({
  notifySlackRateLimit: mockNotifySlack,
}));
vi.mock('../src/services/elasticsearch.service.js', () => ({
  indexEmailJob: mockIndexEmailJob,
}));

import { processEmailJob } from '../src/queue/emailWorker.js';

describe('Email Worker Execution & Rate Limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseEmailJob = {
    id: 'job-123',
    userId: 'user-1',
    senderId: 'sender-1',
    recipient: 'lead@acme.com',
    subject: 'Welcome',
    body: 'Hello there',
    status: 'scheduled',
    sentAt: null,
    hourlyLimit: 50,
    delayBetweenMs: 2000,
    sender: {
      id: 'sender-1',
      email: 'outbox@ethereal.email',
      name: 'Outbox',
    },
  };

  it('skips already-sent jobs idempotently without calling SMTP', async () => {
    mockPrisma.emailJob.findUnique.mockResolvedValueOnce({
      ...baseEmailJob,
      status: 'sent',
      sentAt: new Date(),
    });

    const result = await processEmailJob(
      { id: 'job-123', data: { emailJobId: 'job-123', userId: 'user-1', senderId: 'sender-1' } } as any,
      'lock-token',
    );

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('already_sent');
    expect(mockSendEmailViaSender).not.toHaveBeenCalled();
  });

  it('reschedules job into next hour window, notifies Slack, and throws DelayedError when rate limited', async () => {
    const nextWindowMs = Date.now() + 3600000;
    mockPrisma.emailJob.findUnique.mockResolvedValueOnce(baseEmailJob);
    mockAcquireSendSlot.mockResolvedValueOnce({
      status: 'RATE_LIMITED',
      targetMs: nextWindowMs,
      hourCount: 50,
      hourWindow: 498000,
    });
    mockPrisma.emailJob.update.mockResolvedValueOnce({
      ...baseEmailJob,
      status: 'rate_limited',
      scheduledAt: new Date(nextWindowMs),
    });

    const moveToDelayed = vi.fn().mockResolvedValue(undefined);
    const fakeJob = {
      id: 'job-123',
      data: { emailJobId: 'job-123', userId: 'user-1', senderId: 'sender-1' },
      moveToDelayed,
    } as any;

    await expect(processEmailJob(fakeJob, 'token-abc')).rejects.toBeInstanceOf(DelayedError);

    expect(moveToDelayed).toHaveBeenCalledWith(nextWindowMs, 'token-abc');
    expect(mockPrisma.emailJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-123' },
        data: expect.objectContaining({ status: 'rate_limited' }),
      }),
    );
    expect(mockNotifySlack).toHaveBeenCalledTimes(1);
    expect(mockSendEmailViaSender).not.toHaveBeenCalled();
  });

  it('atomically claims and sends email when slot is allowed', async () => {
    mockPrisma.emailJob.findUnique.mockResolvedValueOnce(baseEmailJob);
    mockAcquireSendSlot.mockResolvedValueOnce({
      status: 'ALLOWED',
      targetMs: Date.now(),
      hourCount: 1,
      hourWindow: 498000,
    });
    mockPrisma.emailJob.updateMany.mockResolvedValueOnce({ count: 1 });
    mockSendEmailViaSender.mockResolvedValueOnce({
      messageId: '<msg-1@ethereal.email>',
      previewUrl: 'https://ethereal.email/message/abc',
    });
    mockPrisma.emailJob.update.mockResolvedValueOnce({
      ...baseEmailJob,
      status: 'sent',
      sentAt: new Date(),
      messageId: '<msg-1@ethereal.email>',
      previewUrl: 'https://ethereal.email/message/abc',
    });

    const result = await processEmailJob(
      {
        id: 'job-123',
        data: { emailJobId: 'job-123', userId: 'user-1', senderId: 'sender-1' },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any,
      'token-abc',
    );

    expect(result.status).toBe('sent');
    expect(result.previewUrl).toBe('https://ethereal.email/message/abc');
    expect(mockSendEmailViaSender).toHaveBeenCalledTimes(1);
    expect(mockIndexEmailJob).toHaveBeenCalledTimes(1);
  });
});
