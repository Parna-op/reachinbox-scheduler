import type { EmailJobItem, EmailStatusCounts, SenderAccount, SlackStatus, UserProfile } from './types';

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') || 'http://localhost:4000';

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let details: unknown;
    try {
      const errBody = await res.json();
      if (typeof errBody?.error === 'string') message = errBody.error;
      details = errBody?.details;
    } catch {
      // ignore parse failure
    }
    throw new ApiError(message, res.status, details);
  }

  return (await res.json()) as T;
}

export function getGoogleLoginUrl(): string {
  return `${API_URL}/api/auth/google`;
}

export function getSlackConnectUrl(): string {
  return `${API_URL}/api/slack/connect`;
}

export function getBullBoardUrl(): string {
  return `${API_URL}/admin/queues`;
}

export async function fetchMe(): Promise<{ user: UserProfile; slack: SlackStatus }> {
  return apiFetch('/api/auth/me');
}

export async function logout(): Promise<void> {
  await apiFetch('/api/auth/logout', { method: 'POST' });
}

export async function disconnectSlack(): Promise<SlackStatus> {
  return apiFetch('/api/slack/disconnect', { method: 'POST' });
}

export async function fetchSenders(): Promise<{ senders: SenderAccount[] }> {
  return apiFetch('/api/senders');
}

export async function provisionEtherealSender(name?: string): Promise<{ sender: SenderAccount }> {
  return apiFetch('/api/senders/ethereal', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function fetchEmails(params: {
  tab: 'scheduled' | 'sent';
  page?: number;
  limit?: number;
}): Promise<{
  items: EmailJobItem[];
  total: number;
  page: number;
  limit: number;
  counts: EmailStatusCounts;
}> {
  const sp = new URLSearchParams({
    tab: params.tab,
    page: String(params.page ?? 1),
    limit: String(params.limit ?? 20),
  });
  return apiFetch(`/api/emails?${sp.toString()}`);
}

export async function searchEmails(params: {
  q: string;
  tab: 'scheduled' | 'sent';
  page?: number;
  limit?: number;
}): Promise<{
  items: EmailJobItem[];
  total: number;
  page: number;
  limit: number;
  searchEngine: 'elasticsearch' | 'postgres-fallback';
}> {
  const sp = new URLSearchParams({
    q: params.q,
    tab: params.tab,
    page: String(params.page ?? 1),
    limit: String(params.limit ?? 20),
  });
  return apiFetch(`/api/emails/search?${sp.toString()}`);
}

export async function fetchEmailStats(): Promise<{ counts: EmailStatusCounts }> {
  return apiFetch('/api/emails/stats');
}

export async function scheduleEmails(payload: {
  senderId?: string;
  subject: string;
  body: string;
  recipients: string[];
  startTime?: string;
  delayBetweenMs?: number;
  hourlyLimit?: number;
  idempotencyKey?: string;
}): Promise<{
  scheduledCount: number;
  skippedDuplicates: number;
  totalUniqueRecipients: number;
  delayBetweenMs: number;
  hourlyLimit: number;
  startTime: string;
  sender: { id: string; email: string; name: string };
}> {
  return apiFetch('/api/emails/schedule', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
