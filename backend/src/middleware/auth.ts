import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { prisma } from '../db/prisma.js';

export interface SessionPayload {
  userId: string;
  email: string;
}

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    googleId: string;
    email: string;
    name: string;
    avatarUrl: string | null;
  };
}

export function signSessionToken(payload: SessionPayload): string {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.SESSION_TTL_SECONDS,
  });
}

export function verifySessionToken(token: string): SessionPayload {
  return jwt.verify(token, config.JWT_SECRET) as SessionPayload;
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(config.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    maxAge: config.SESSION_TTL_SECONDS * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(config.SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    path: '/',
  });
}

export function extractTokenFromRequest(req: Request): string | null {
  const cookieToken = req.cookies?.[config.SESSION_COOKIE_NAME];
  if (typeof cookieToken === 'string' && cookieToken.length > 0) {
    return cookieToken;
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  return null;
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const decoded = verifySessionToken(token);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        googleId: true,
        email: true,
        name: true,
        avatarUrl: true,
      },
    });

    if (!user) {
      clearSessionCookie(res);
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}
