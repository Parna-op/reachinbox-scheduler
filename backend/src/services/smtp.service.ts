import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { Sender } from '@prisma/client';
import { config } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';

const transporterPool = new Map<string, Transporter>();

export function getTransporterForSender(sender: Sender): Transporter {
  const cacheKey = `${sender.id}:${sender.smtpHost}:${sender.smtpPort}:${sender.smtpUser}`;
  const existing = transporterPool.get(cacheKey);
  if (existing) {
    return existing;
  }

  const transporter = nodemailer.createTransport({
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpSecure,
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    auth: {
      user: sender.smtpUser,
      pass: sender.smtpPass,
    },
  });

  transporterPool.set(cacheKey, transporter);
  return transporter;
}

export async function sendEmailViaSender(params: {
  sender: Sender;
  to: string;
  subject: string;
  body: string;
}): Promise<{ messageId: string; previewUrl: string | null }> {
  const transporter = getTransporterForSender(params.sender);

  const isHtml = /<[a-z][\s\S]*>/i.test(params.body);
  const info = await transporter.sendMail({
    from: `"${params.sender.name}" <${params.sender.email}>`,
    to: params.to,
    subject: params.subject,
    text: isHtml ? params.body.replace(/<[^>]+>/g, ' ').trim() : params.body,
    html: isHtml ? params.body : params.body.replace(/\n/g, '<br/>'),
  });

  const previewUrl = nodemailer.getTestMessageUrl(info) || null;
  return {
    messageId: info.messageId,
    previewUrl,
  };
}

export async function createEtherealSenderForUser(params: {
  userId: string;
  name?: string;
}): Promise<Sender> {
  let smtpUser = config.ETHEREAL_USER;
  let smtpPass = config.ETHEREAL_PASS;
  let smtpHost = 'smtp.ethereal.email';
  let smtpPort = 587;
  let smtpSecure = false;

  if (!smtpUser || !smtpPass) {
    const testAccount = await nodemailer.createTestAccount();
    smtpUser = testAccount.user;
    smtpPass = testAccount.pass;
    smtpHost = testAccount.smtp.host;
    smtpPort = testAccount.smtp.port;
    smtpSecure = testAccount.smtp.secure;
  }

  const existingCount = await prisma.sender.count({
    where: { userId: params.userId },
  });

  const sender = await prisma.sender.upsert({
    where: {
      userId_email: {
        userId: params.userId,
        email: smtpUser,
      },
    },
    update: {
      smtpHost,
      smtpPort,
      smtpSecure,
      smtpUser,
      smtpPass,
      isEthereal: true,
    },
    create: {
      userId: params.userId,
      email: smtpUser,
      name: params.name || config.ETHEREAL_FROM_NAME || 'ReachInbox Ethereal Sender',
      smtpHost,
      smtpPort,
      smtpSecure,
      smtpUser,
      smtpPass,
      isEthereal: true,
      isDefault: existingCount === 0,
    },
  });

  logger.info({ userId: params.userId, senderEmail: sender.email }, 'Provisioned Ethereal sender');
  return sender;
}

export function closeAllTransporters(): void {
  for (const transporter of transporterPool.values()) {
    transporter.close();
  }
  transporterPool.clear();
}
