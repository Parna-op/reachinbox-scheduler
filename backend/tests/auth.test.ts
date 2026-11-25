import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  slackIntegration: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  sender: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    upsert: vi.fn(),
  },
  emailJob: {
    groupBy: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    createMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  $queryRaw: vi.fn(),
}));

vi.mock('../src/db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../src/redis/client.js', () => ({
  redis: {
    ping: vi.fn().mockResolvedValue('PONG'),
    set: vi.fn().mockResolvedValue('OK'),
    eval: vi.fn(),
  },
  createRedisConnection: vi.fn(() => ({
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
  })),
}));
vi.mock('../src/queue/emailQueue.js', () => ({
  emailQueue: {
    addBulk: vi.fn().mockResolvedValue([]),
    getJobCounts: vi.fn().mockResolvedValue({}),
  },
  enqueueEmailJobsBulk: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bull-board/api', () => ({
  createBullBoard: vi.fn(),
}));
vi.mock('@bull-board/api/bullMQAdapter', () => ({
  BullMQAdapter: vi.fn(),
}));
vi.mock('@bull-board/express', () => ({
  ExpressAdapter: vi.fn().mockImplementation(() => ({
    setBasePath: vi.fn(),
    getRouter: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  })),
}));

import { createApp } from '../src/app.js';
import { signSessionToken } from '../src/middleware/auth.js';
import { invokeApp } from './helpers/invokeApp.js';

describe('Auth & Slack routes', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 on /api/auth/me without a session cookie', async () => {
    const res = await invokeApp(app, { method: 'GET', url: '/api/auth/me' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  it('returns user profile and slack status on /api/auth/me with valid JWT cookie', async () => {
    const user = {
      id: 'user-1',
      googleId: 'google-sub-123',
      email: 'alex@reachinbox.dev',
      name: 'Alex Rivera',
      avatarUrl: 'https://example.com/avatar.png',
    };
    mockPrisma.user.findUnique.mockResolvedValueOnce(user);
    mockPrisma.slackIntegration.findUnique.mockResolvedValueOnce({
      isActive: true,
      teamName: 'ReachInbox HQ',
      channelName: '#outbox-alerts',
      updatedAt: new Date('2026-11-25T05:00:00Z'),
    });

    const token = signSessionToken({ userId: user.id, email: user.email });
    const res = await invokeApp(app, {
      method: 'GET',
      url: '/api/auth/me',
      headers: { Cookie: `reachinbox_session=${token}` },
    });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('alex@reachinbox.dev');
    expect(res.body.slack.connected).toBe(true);
    expect(res.body.slack.teamName).toBe('ReachInbox HQ');
  });

  it('clears session cookie on POST /api/auth/logout', async () => {
    const res = await invokeApp(app, { method: 'POST', url: '/api/auth/logout' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const setCookieHeader = String(res.headers['set-cookie'] ?? '');
    expect(setCookieHeader).toContain('reachinbox_session=;');
  });

  it('disconnects Slack immediately in PostgreSQL on POST /api/slack/disconnect', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      googleId: 'g-1',
      email: 'alex@reachinbox.dev',
      name: 'Alex',
      avatarUrl: null,
    });
    mockPrisma.slackIntegration.updateMany.mockResolvedValueOnce({ count: 1 });

    const token = signSessionToken({ userId: 'user-1', email: 'alex@reachinbox.dev' });
    const res = await invokeApp(app, {
      method: 'POST',
      url: '/api/slack/disconnect',
      headers: { Cookie: `reachinbox_session=${token}` },
    });

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(mockPrisma.slackIntegration.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { isActive: false, accessToken: null, webhookUrl: null },
    });
  });
});
