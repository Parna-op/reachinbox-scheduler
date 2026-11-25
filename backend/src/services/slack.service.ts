import { prisma } from '../db/prisma.js';
import { redis } from '../redis/client.js';
import { logger } from '../utils/logger.js';

export interface RateLimitSlackAlertInput {
  userId: string;
  senderId: string;
  senderEmail: string;
  recipient: string;
  hourlyLimit: number;
  currentHourWindow: number;
  rescheduledAt: Date;
}

/**
 * Sends a live Slack notification to the user's connected Slack workspace when
 * an email job hits the per-sender hourly rate limit and is rescheduled.
 * Always reads live state from PostgreSQL so disconnect/reconnect takes effect
 * immediately without restarting or redeploying the worker.
 */
export async function notifySlackRateLimit(input: RateLimitSlackAlertInput): Promise<boolean> {
  try {
    const integration = await prisma.slackIntegration.findUnique({
      where: { userId: input.userId },
    });

    if (!integration || !integration.isActive) {
      logger.debug(
        { userId: input.userId, senderId: input.senderId },
        'Slack not connected or inactive; skipping rate-limit alert',
      );
      return false;
    }

    // Deduplicate Slack alerts per sender + hour window so bulk jobs do not spam Slack
    const dedupeKey = `slack:rate_limit_notified:${input.userId}:${input.senderId}:${input.currentHourWindow}`;
    const acquired = await redis.set(dedupeKey, '1', 'EX', 3600, 'NX');
    if (acquired !== 'OK') {
      return false;
    }

    const messageText = [
      `:warning: *ReachInbox Hourly Rate Limit Reached*`,
      `• *Sender:* \`${input.senderEmail}\``,
      `• *Hourly Limit:* ${input.hourlyLimit} emails/hour`,
      `• *Next Available Window:* ${input.rescheduledAt.toISOString()}`,
      `• *Triggered By Recipient:* ${input.recipient}`,
      `Queued emails are preserved in order and automatically rescheduled into the next hour window.`,
    ].join('\n');

    if (integration.accessToken && integration.channelId) {
      const resp = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${integration.accessToken}`,
        },
        body: JSON.stringify({
          channel: integration.channelId,
          text: messageText,
        }),
      });

      const data = (await resp.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        logger.info({ userId: input.userId, channelId: integration.channelId }, 'Sent Slack rate-limit alert');
        return true;
      }

      logger.warn(
        { userId: input.userId, slackError: data.error },
        'Slack chat.postMessage failed; attempting webhook fallback if available',
      );
    }

    if (integration.webhookUrl) {
      const resp = await fetch(integration.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: messageText }),
      });

      if (resp.ok) {
        logger.info({ userId: input.userId }, 'Sent Slack rate-limit alert via webhook');
        return true;
      }

      logger.warn({ userId: input.userId, status: resp.status }, 'Slack webhook delivery failed');
    }

    return false;
  } catch (err) {
    // Never fail job processing if Slack notification fails
    logger.error({ err, userId: input.userId }, 'Failed to send Slack rate-limit alert');
    return false;
  }
}
