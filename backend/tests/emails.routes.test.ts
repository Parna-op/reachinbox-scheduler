import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  sender: { findFirst: vi.fn(), count: vi.fn(), upsert: vi.fn() },
  emailJob: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
  },
  slackIntegration: { findUnique: vi.fn() },
}));

const mockEnqueueBulk = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockBulkIndex = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSearchEs = vi.hoisted(() => vi.fn());

vi.mock('../src/db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../src/redis/client.js', () => ({
  redis: { ping: vi.fn().mockResolvedValue('PONG'), set: vi.fn(), eval: vi.fn() },
  createRedisConnection: vi.fn(() => ({ on: vi.fn(), quit: vi.fn() })),
}));
vi.mock('../src/queue/emailQueue.js', () => ({
  emailQueue: { addBulk: vi.fn(), getJobCounts: vi.fn() },
  enqueueEmailJobsBulk: mockEnqueueBulk,
}));
vi.mock('../src/services/elasticsearch.service.js', () => ({
  esClient: { ping: vi.fn().mockResolvedValue(true) },
  ensureEmailIndex: vi.fn().mockResolvedValue(true),
  indexEmailJob: vi.fn().mockResolvedValue(undefined),
  bulkIndexEmailJobs: mockBulkIndex,
  searchEmailJobsInEs: mockSearchEs,
}));
vi.mock('@bull-board/api', () => ({ createBullBoard: vi.fn() }));
vi.mock('@bull-board/api/bullMQAdapter', () => ({ BullMQAdapter: vi.fn() }));
vi.mock('@bull-board/express', () => ({
  ExpressAdapter: vi.fn().mockImplementation(() => ({
    setBasePath: vi.fn(),
    getRouter: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  })),
}));

import { createApp } from '../src/app.js';
import { signSessionToken } from '../src/middleware/auth.js';
import { invokeApp } from './helpers/invokeApp.js';

describe('Email scheduling and search routes', () => {
  const app = createApp();
  const authUser = {
    id: 'user-1',
    googleId: 'g-1',
    email: 'sender@reachinbox.dev',
    name: 'Sender User',
    avatarUrl: null,
  };
  const cookie = `reachinbox_session=${signSessionToken({ userId: authUser.id, email: authUser.email })}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue(authUser);
  });

  it('schedules 1,050 leads in batches with staggered delays and deduplicates recipients', async () => {
    const sender = {
      id: 'sender-1',
      userId: authUser.id,
      email: 'ethereal@ethereal.email',
      name: 'Ethereal',
      smtpHost: 'smtp.ethereal.email',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: 'ethereal@ethereal.email',
      smtpPass: 'secret',
      isEthereal: true,
      isDefault: true,
    };

    mockPrisma.sender.findFirst.mockResolvedValueOnce(sender);
    mockPrisma.emailJob.findMany
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id, idx) => ({
          id,
          userId: authUser.id,
          senderId: sender.id,
          recipient: `lead${idx}@example.com`,
          subject: 'Bulk Campaign',
          body: 'Hello lead!',
          scheduledAt: new Date(Date.now() + idx * 2000),
          status: 'scheduled',
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
    mockPrisma.emailJob.createMany.mockResolvedValue({ count: 500 });

    const recipients = Array.from({ length: 1050 }, (_, i) => `lead${i}@example.com`);
    recipients.push('LEAD0@example.com');

    const res = await invokeApp(app, {
      method: 'POST',
      url: '/api/emails/schedule',
      headers: { Cookie: cookie },
      body: {
        subject: 'Bulk Campaign',
        body: 'Hello lead!',
        recipients,
        delayBetweenMs: 500,
        hourlyLimit: 100,
        idempotencyKey: 'campaign-batch-1050',
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.scheduledCount).toBe(1050);
    expect(res.body.totalUniqueRecipients).toBe(1050);
    expect(res.body.delayBetweenMs).toBe(2000);
    expect(mockPrisma.emailJob.createMany).toHaveBeenCalledTimes(3);
    expect(mockEnqueueBulk).toHaveBeenCalledTimes(1);
    expect(mockEnqueueBulk.mock.calls[0][0]).toHaveLength(1050);
    expect(mockBulkIndex).toHaveBeenCalledTimes(1);
  });

  it('searches emails via Elasticsearch and hydrates ordered records from PostgreSQL', async () => {
    mockSearchEs.mockResolvedValueOnce({
      ids: ['job-2', 'job-1'],
      total: 2,
    });
    mockPrisma.emailJob.findMany.mockResolvedValueOnce([
      { id: 'job-1', recipient: 'a@test.com', subject: 'Follow up', status: 'scheduled' },
      { id: 'job-2', recipient: 'b@test.com', subject: 'Follow up 2', status: 'scheduled' },
    ]);

    const res = await invokeApp(app, {
      method: 'GET',
      url: '/api/emails/search?q=Follow&tab=scheduled',
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    expect(res.body.searchEngine).toBe('elasticsearch');
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual(['job-2', 'job-1']);
  });
});
