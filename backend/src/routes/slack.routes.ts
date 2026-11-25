import crypto from 'node:crypto';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const SLACK_STATE_COOKIE = 'reachinbox_slack_state';

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  team?: {
    id: string;
    name: string;
  };
  incoming_webhook?: {
    channel: string;
    channel_id: string;
    url: string;
  };
}

export const slackRouter = Router();

slackRouter.get('/connect', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) {
    res.status(503).json({
      error: 'Slack OAuth is not configured on the server (missing SLACK_CLIENT_ID / SLACK_CLIENT_SECRET)',
    });
    return;
  }

  const nonce = crypto.randomBytes(20).toString('hex');
  const stateToken = jwt.sign(
    {
      userId: req.user!.id,
      nonce,
      purpose: 'slack_oauth',
    },
    config.JWT_SECRET,
    { expiresIn: '10m' },
  );

  res.cookie(SLACK_STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    maxAge: 10 * 60 * 1000,
    path: '/',
  });

  const params = new URLSearchParams({
    client_id: config.SLACK_CLIENT_ID,
    scope: 'chat:write,incoming-webhook',
    redirect_uri: config.SLACK_REDIRECT_URI,
    state: stateToken,
  });

  res.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`);
});

slackRouter.get('/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const slackError = typeof req.query.error === 'string' ? req.query.error : '';

  if (slackError) {
    res.redirect(`${config.FRONTEND_URL}/dashboard?slack=error&reason=${encodeURIComponent(slackError)}`);
    return;
  }

  if (!code || !state) {
    res.redirect(`${config.FRONTEND_URL}/dashboard?slack=error&reason=missing_params`);
    return;
  }

  try {
    const decoded = jwt.verify(state, config.JWT_SECRET) as {
      userId: string;
      nonce: string;
      purpose: string;
    };

    const cookieNonce = req.cookies?.[SLACK_STATE_COOKIE];
    res.clearCookie(SLACK_STATE_COOKIE, { path: '/' });

    if (decoded.purpose !== 'slack_oauth' || !cookieNonce || cookieNonce !== decoded.nonce) {
      res.redirect(`${config.FRONTEND_URL}/dashboard?slack=error&reason=invalid_state`);
      return;
    }

    const tokenResp = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.SLACK_CLIENT_ID,
        client_secret: config.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: config.SLACK_REDIRECT_URI,
      }).toString(),
    });

    const data = (await tokenResp.json()) as SlackOAuthResponse;
    if (!tokenResp.ok || !data.ok) {
      logger.error({ slackError: data.error }, 'Slack OAuth token exchange failed');
      res.redirect(
        `${config.FRONTEND_URL}/dashboard?slack=error&reason=${encodeURIComponent(data.error || 'exchange_failed')}`,
      );
      return;
    }

    await prisma.slackIntegration.upsert({
      where: { userId: decoded.userId },
      update: {
        teamId: data.team?.id ?? null,
        teamName: data.team?.name ?? null,
        botUserId: data.bot_user_id ?? null,
        accessToken: data.access_token ?? null,
        webhookUrl: data.incoming_webhook?.url ?? null,
        channelId: data.incoming_webhook?.channel_id ?? null,
        channelName: data.incoming_webhook?.channel ?? null,
        isActive: true,
      },
      create: {
        userId: decoded.userId,
        teamId: data.team?.id ?? null,
        teamName: data.team?.name ?? null,
        botUserId: data.bot_user_id ?? null,
        accessToken: data.access_token ?? null,
        webhookUrl: data.incoming_webhook?.url ?? null,
        channelId: data.incoming_webhook?.channel_id ?? null,
        channelName: data.incoming_webhook?.channel ?? null,
        isActive: true,
      },
    });

    res.redirect(`${config.FRONTEND_URL}/dashboard?slack=connected`);
  } catch (err) {
    logger.error({ err }, 'Slack OAuth callback error');
    res.redirect(`${config.FRONTEND_URL}/dashboard?slack=error&reason=callback_failed`);
  }
});

slackRouter.get('/status', requireAuth, async (req: AuthenticatedRequest, res) => {
  const integration = await prisma.slackIntegration.findUnique({
    where: { userId: req.user!.id },
    select: {
      isActive: true,
      teamName: true,
      channelName: true,
      updatedAt: true,
    },
  });

  res.json({
    connected: Boolean(integration?.isActive),
    teamName: integration?.isActive ? integration.teamName : null,
    channelName: integration?.isActive ? integration.channelName : null,
    updatedAt: integration?.isActive ? integration.updatedAt : null,
  });
});

async function handleDisconnect(req: AuthenticatedRequest, res: any): Promise<void> {
  await prisma.slackIntegration.updateMany({
    where: { userId: req.user!.id },
    data: {
      isActive: false,
      accessToken: null,
      webhookUrl: null,
    },
  });

  res.json({
    connected: false,
    teamName: null,
    channelName: null,
  });
}

slackRouter.post('/disconnect', requireAuth, handleDisconnect);
slackRouter.delete('/disconnect', requireAuth, handleDisconnect);
