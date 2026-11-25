import crypto from 'node:crypto';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import {
  clearSessionCookie,
  requireAuth,
  setSessionCookie,
  signSessionToken,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const OAUTH_STATE_COOKIE = 'reachinbox_oauth_state';

interface GoogleTokenResponse {
  access_token: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

export const authRouter = Router();

authRouter.get('/google', (_req, res) => {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    res.redirect(`${config.FRONTEND_URL}/login?error=google_oauth_not_configured`);
    return;
  }

  const nonce = crypto.randomBytes(24).toString('hex');
  const stateToken = jwt.sign({ nonce, purpose: 'google_oauth' }, config.JWT_SECRET, {
    expiresIn: '10m',
  });

  res.cookie(OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    maxAge: 10 * 60 * 1000,
    path: '/',
  });

  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: config.GOOGLE_CALLBACK_URL,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
    state: stateToken,
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

authRouter.get('/google/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const oauthError = typeof req.query.error === 'string' ? req.query.error : '';

  if (oauthError) {
    res.redirect(`${config.FRONTEND_URL}/login?error=${encodeURIComponent(oauthError)}`);
    return;
  }

  if (!code || !state) {
    res.redirect(`${config.FRONTEND_URL}/login?error=missing_oauth_params`);
    return;
  }

  try {
    const decodedState = jwt.verify(state, config.JWT_SECRET) as { nonce: string; purpose: string };
    const cookieNonce = req.cookies?.[OAUTH_STATE_COOKIE];
    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });

    if (decodedState.purpose !== 'google_oauth' || !cookieNonce || cookieNonce !== decodedState.nonce) {
      res.redirect(`${config.FRONTEND_URL}/login?error=invalid_oauth_state`);
      return;
    }

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.GOOGLE_CLIENT_ID,
        client_secret: config.GOOGLE_CLIENT_SECRET,
        redirect_uri: config.GOOGLE_CALLBACK_URL,
        grant_type: 'authorization_code',
      }).toString(),
    });

    const tokenData = (await tokenResp.json()) as GoogleTokenResponse;
    if (!tokenResp.ok || !tokenData.access_token) {
      logger.error({ tokenData }, 'Google token exchange failed');
      res.redirect(`${config.FRONTEND_URL}/login?error=token_exchange_failed`);
      return;
    }

    const userInfoResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userInfoResp.ok) {
      res.redirect(`${config.FRONTEND_URL}/login?error=userinfo_fetch_failed`);
      return;
    }

    const profile = (await userInfoResp.json()) as GoogleUserInfo;
    if (!profile.sub || !profile.email) {
      res.redirect(`${config.FRONTEND_URL}/login?error=incomplete_google_profile`);
      return;
    }

    const user = await prisma.user.upsert({
      where: { googleId: profile.sub },
      update: {
        email: profile.email,
        name: profile.name || profile.email.split('@')[0],
        avatarUrl: profile.picture ?? null,
      },
      create: {
        googleId: profile.sub,
        email: profile.email,
        name: profile.name || profile.email.split('@')[0],
        avatarUrl: profile.picture ?? null,
      },
    });

    const sessionToken = signSessionToken({ userId: user.id, email: user.email });
    setSessionCookie(res, sessionToken);

    res.redirect(`${config.FRONTEND_URL}/dashboard`);
  } catch (err) {
    logger.error({ err }, 'Google OAuth callback error');
    res.redirect(`${config.FRONTEND_URL}/login?error=oauth_callback_error`);
  }
});

authRouter.get('/me', requireAuth, async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const slack = await prisma.slackIntegration.findUnique({
    where: { userId: user.id },
    select: {
      isActive: true,
      teamName: true,
      channelName: true,
      updatedAt: true,
    },
  });

  res.json({
    user,
    slack: {
      connected: Boolean(slack?.isActive),
      teamName: slack?.isActive ? slack.teamName : null,
      channelName: slack?.isActive ? slack.channelName : null,
      updatedAt: slack?.isActive ? slack.updatedAt : null,
    },
  });
});

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});
