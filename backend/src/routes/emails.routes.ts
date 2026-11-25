import crypto from 'node:crypto';
import { Router } from 'express';
import { EmailJobStatus } from '@prisma/client';
import { z } from 'zod';
import { config } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { enqueueEmailJobsBulk } from '../queue/emailQueue.js';
import { bulkIndexEmailJobs, searchEmailJobsInEs } from '../services/elasticsearch.service.js';
import { createEtherealSenderForUser } from '../services/smtp.service.js';
import { logger } from '../utils/logger.js';

export const emailsRouter = Router();

const scheduleSchema = z.object({
  senderId: z.string().uuid().optional(),
  subject: z.string().trim().min(1, 'Subject is required').max(300),
  body: z.string().trim().min(1, 'Email body is required').max(50000),
  recipients: z
    .array(z.string().trim().email())
    .min(1, 'At least one valid recipient email is required')
    .max(10000, 'Maximum 10,000 recipients per batch'),
  startTime: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  delayBetweenMs: z.coerce.number().int().min(0).max(3600000).optional(),
  hourlyLimit: z.coerce.number().int().min(1).max(100000).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

const SCHEDULED_STATUSES: EmailJobStatus[] = ['scheduled', 'processing', 'rate_limited'];
const SENT_STATUSES: EmailJobStatus[] = ['sent', 'failed'];

function getStatusesForTab(tab: string | undefined, explicitStatus?: string): EmailJobStatus[] {
  if (explicitStatus && Object.values(EmailJobStatus).includes(explicitStatus as EmailJobStatus)) {
    return [explicitStatus as EmailJobStatus];
  }
  return tab === 'sent' ? SENT_STATUSES : SCHEDULED_STATUSES;
}

async function getStatusCounts(userId: string) {
  const grouped = await prisma.emailJob.groupBy({
    by: ['status'],
    where: { userId },
    _count: { _all: true },
  });

  const counts = {
    scheduled: 0,
    processing: 0,
    rate_limited: 0,
    sent: 0,
    failed: 0,
  };

  for (const row of grouped) {
    counts[row.status] = row._count._all;
  }

  return counts;
}

emailsRouter.post('/schedule', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
      return;
    }

    const userId = req.user!.id;
    const payload = parsed.data;

    // Resolve sender (explicit, default, or auto-provisioned Ethereal)
    let sender = payload.senderId
      ? await prisma.sender.findFirst({
          where: { id: payload.senderId, userId },
        })
      : await prisma.sender.findFirst({
          where: { userId },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        });

    if (!sender) {
      if (payload.senderId) {
        res.status(404).json({ error: 'Selected sender account not found' });
        return;
      }
      sender = await createEtherealSenderForUser({
        userId,
        name: `${req.user!.name} (Ethereal)`,
      });
    }

    // Deduplicate recipients case-insensitively while preserving order
    const seenRecipients = new Set<string>();
    const uniqueRecipients: string[] = [];
    for (const email of payload.recipients) {
      const normalized = email.toLowerCase();
      if (!seenRecipients.has(normalized)) {
        seenRecipients.add(normalized);
        uniqueRecipients.push(normalized);
      }
    }

    const startMs = payload.startTime ? new Date(payload.startTime).getTime() : Date.now();
    if (Number.isNaN(startMs)) {
      res.status(400).json({ error: 'Invalid startTime value' });
      return;
    }

    const effectiveDelayMs = Math.max(
      config.MIN_DELAY_MS,
      payload.delayBetweenMs ?? config.MIN_DELAY_MS,
    );
    const effectiveHourlyLimit = payload.hourlyLimit ?? config.MAX_EMAILS_PER_HOUR;

    const batchKey =
      payload.idempotencyKey ||
      crypto
        .createHash('sha256')
        .update(`${userId}:${sender.id}:${payload.subject}:${startMs}:${crypto.randomUUID()}`)
        .digest('hex');

    const candidates = uniqueRecipients.map((recipient, idx) => {
      const scheduledAt = new Date(startMs + idx * effectiveDelayMs);
      const itemIdempotencyKey = crypto
        .createHash('sha256')
        .update(`${userId}:${batchKey}:${recipient}:${idx}`)
        .digest('hex');

      const id = crypto.randomUUID();
      return {
        id,
        userId,
        senderId: sender.id,
        idempotencyKey: itemIdempotencyKey,
        recipient,
        subject: payload.subject,
        body: payload.body,
        scheduledAt,
        status: EmailJobStatus.scheduled,
        delayBetweenMs: effectiveDelayMs,
        hourlyLimit: effectiveHourlyLimit,
        bullJobId: id,
      };
    });

    // Check which idempotency keys already exist so retries do not re-enqueue
    const existingRows = await prisma.emailJob.findMany({
      where: {
        idempotencyKey: { in: candidates.map((c) => c.idempotencyKey) },
      },
      select: { idempotencyKey: true },
    });
    const existingKeySet = new Set(existingRows.map((r) => r.idempotencyKey));
    const newRecords = candidates.filter((c) => !existingKeySet.has(c.idempotencyKey));

    if (newRecords.length > 0) {
      const chunkSize = 500;
      for (let i = 0; i < newRecords.length; i += chunkSize) {
        await prisma.emailJob.createMany({
          data: newRecords.slice(i, i + chunkSize),
          skipDuplicates: true,
        });
      }

      const insertedJobs = await prisma.emailJob.findMany({
        where: { id: { in: newRecords.map((r) => r.id) } },
      });

      await enqueueEmailJobsBulk(
        insertedJobs.map((job) => ({
          emailJobId: job.id,
          userId: job.userId,
          senderId: job.senderId,
          scheduledAt: job.scheduledAt,
        })),
      );

      void bulkIndexEmailJobs(insertedJobs);
    }

    res.status(201).json({
      scheduledCount: newRecords.length,
      skippedDuplicates: candidates.length - newRecords.length,
      totalUniqueRecipients: uniqueRecipients.length,
      delayBetweenMs: effectiveDelayMs,
      hourlyLimit: effectiveHourlyLimit,
      startTime: new Date(startMs).toISOString(),
      sender: {
        id: sender.id,
        email: sender.email,
        name: sender.name,
      },
    });
  } catch (err) {
    next(err);
  }
});

emailsRouter.get('/stats', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const counts = await getStatusCounts(req.user!.id);
    res.json({ counts });
  } catch (err) {
    next(err);
  }
});

emailsRouter.get('/search', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const tab = typeof req.query.tab === 'string' ? req.query.tab : 'scheduled';
    const explicitStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const statuses = getStatusesForTab(tab, explicitStatus);
    const sortField: 'scheduledAt' | 'sentAt' = tab === 'sent' ? 'sentAt' : 'scheduledAt';
    const sortOrder: 'asc' | 'desc' = tab === 'sent' ? 'desc' : 'asc';

    try {
      const esResult = await searchEmailJobsInEs({
        userId,
        query: q,
        statuses,
        page,
        limit,
        sortField,
        sortOrder,
      });

      if (esResult.ids.length === 0) {
        res.json({
          items: [],
          total: esResult.total,
          page,
          limit,
          searchEngine: 'elasticsearch',
        });
        return;
      }

      const dbRows = await prisma.emailJob.findMany({
        where: {
          id: { in: esResult.ids },
          userId,
        },
        include: {
          sender: { select: { id: true, email: true, name: true } },
        },
      });

      const byId = new Map(dbRows.map((row) => [row.id, row]));
      const orderedItems = esResult.ids
        .map((id) => byId.get(id))
        .filter((row): row is NonNullable<typeof row> => Boolean(row));

      res.json({
        items: orderedItems,
        total: esResult.total,
        page,
        limit,
        searchEngine: 'elasticsearch',
      });
      return;
    } catch (esErr) {
      logger.warn({ err: esErr }, 'Elasticsearch search failed; falling back to PostgreSQL query');
    }

    // PostgreSQL fallback when Elasticsearch is unavailable
    const where = {
      userId,
      status: { in: statuses },
      ...(q
        ? {
            OR: [
              { recipient: { contains: q, mode: 'insensitive' as const } },
              { subject: { contains: q, mode: 'insensitive' as const } },
              { body: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.emailJob.findMany({
        where,
        include: {
          sender: { select: { id: true, email: true, name: true } },
        },
        orderBy:
          tab === 'sent'
            ? [{ sentAt: 'desc' }, { createdAt: 'desc' }]
            : [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.emailJob.count({ where }),
    ]);

    res.json({
      items,
      total,
      page,
      limit,
      searchEngine: 'postgres-fallback',
    });
  } catch (err) {
    next(err);
  }
});

emailsRouter.get('/', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const tab = typeof req.query.tab === 'string' ? req.query.tab : 'scheduled';
    const explicitStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const statuses = getStatusesForTab(tab, explicitStatus);

    const where = {
      userId,
      status: { in: statuses },
    };

    const [items, total, counts] = await Promise.all([
      prisma.emailJob.findMany({
        where,
        include: {
          sender: { select: { id: true, email: true, name: true } },
        },
        orderBy:
          tab === 'sent'
            ? [{ sentAt: 'desc' }, { createdAt: 'desc' }]
            : [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.emailJob.count({ where }),
      getStatusCounts(userId),
    ]);

    res.json({
      items,
      total,
      page,
      limit,
      counts,
    });
  } catch (err) {
    next(err);
  }
});
