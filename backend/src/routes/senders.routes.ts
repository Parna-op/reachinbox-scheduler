import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { createEtherealSenderForUser } from '../services/smtp.service.js';

export const sendersRouter = Router();

const createSenderSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  smtpHost: z.string().min(1).default('smtp.ethereal.email'),
  smtpPort: z.coerce.number().int().positive().default(587),
  smtpSecure: z.boolean().default(false),
  smtpUser: z.string().min(1),
  smtpPass: z.string().min(1),
  isEthereal: z.boolean().default(true),
  isDefault: z.boolean().optional(),
});

function sanitizeSender<T extends { smtpPass?: string }>(sender: T): Omit<T, 'smtpPass'> {
  const { smtpPass: _removed, ...rest } = sender;
  return rest;
}

sendersRouter.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  const senders = await prisma.sender.findMany({
    where: { userId: req.user!.id },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });

  res.json({ senders: senders.map(sanitizeSender) });
});

sendersRouter.post('/ethereal', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : undefined;
    const sender = await createEtherealSenderForUser({
      userId: req.user!.id,
      name: name || `${req.user!.name} (Ethereal)`,
    });

    res.status(201).json({ sender: sanitizeSender(sender) });
  } catch (err) {
    next(err);
  }
});

sendersRouter.post('/', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const parsed = createSenderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid sender payload', details: parsed.error.flatten() });
      return;
    }

    const data = parsed.data;
    const existingCount = await prisma.sender.count({ where: { userId: req.user!.id } });
    const shouldBeDefault = data.isDefault ?? existingCount === 0;

    if (shouldBeDefault) {
      await prisma.sender.updateMany({
        where: { userId: req.user!.id },
        data: { isDefault: false },
      });
    }

    const sender = await prisma.sender.upsert({
      where: {
        userId_email: {
          userId: req.user!.id,
          email: data.email.toLowerCase(),
        },
      },
      update: {
        name: data.name,
        smtpHost: data.smtpHost,
        smtpPort: data.smtpPort,
        smtpSecure: data.smtpSecure,
        smtpUser: data.smtpUser,
        smtpPass: data.smtpPass,
        isEthereal: data.isEthereal,
        isDefault: shouldBeDefault,
      },
      create: {
        userId: req.user!.id,
        email: data.email.toLowerCase(),
        name: data.name,
        smtpHost: data.smtpHost,
        smtpPort: data.smtpPort,
        smtpSecure: data.smtpSecure,
        smtpUser: data.smtpUser,
        smtpPass: data.smtpPass,
        isEthereal: data.isEthereal,
        isDefault: shouldBeDefault,
      },
    });

    res.status(201).json({ sender: sanitizeSender(sender) });
  } catch (err) {
    next(err);
  }
});

sendersRouter.patch('/:id/default', requireAuth, async (req: AuthenticatedRequest, res) => {
  const senderId = String(req.params.id);
  const owned = await prisma.sender.findFirst({
    where: { id: senderId, userId: req.user!.id },
  });

  if (!owned) {
    res.status(404).json({ error: 'Sender not found' });
    return;
  }

  await prisma.$transaction([
    prisma.sender.updateMany({
      where: { userId: req.user!.id },
      data: { isDefault: false },
    }),
    prisma.sender.update({
      where: { id: owned.id },
      data: { isDefault: true },
    }),
  ]);

  res.json({ success: true });
});
