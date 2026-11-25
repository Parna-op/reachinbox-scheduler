export interface UserProfile {
  id: string;
  googleId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface SlackStatus {
  connected: boolean;
  teamName: string | null;
  channelName: string | null;
  updatedAt: string | null;
}

export interface SenderAccount {
  id: string;
  email: string;
  name: string;
  smtpHost: string;
  smtpPort: number;
  isEthereal: boolean;
  isDefault: boolean;
  createdAt: string;
}

export type EmailStatus = 'scheduled' | 'processing' | 'sent' | 'failed' | 'rate_limited';

export interface EmailJobItem {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  scheduledAt: string;
  sentAt: string | null;
  status: EmailStatus;
  delayBetweenMs: number | null;
  hourlyLimit: number | null;
  attempts: number;
  messageId: string | null;
  previewUrl: string | null;
  error: string | null;
  createdAt: string;
  sender?: {
    id: string;
    email: string;
    name: string;
  };
}

export interface EmailStatusCounts {
  scheduled: number;
  processing: number;
  rate_limited: number;
  sent: number;
  failed: number;
}
