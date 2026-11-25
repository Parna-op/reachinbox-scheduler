import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const backendRoot = path.resolve(__dirname, '../..');
const monorepoRoot = path.resolve(backendRoot, '..');

// Load monorepo root .env first, then backend/.env if present
dotenv.config({ path: path.join(monorepoRoot, '.env') });
dotenv.config({ path: path.join(backendRoot, '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgresql://reachinbox:reachinbox_pass@localhost:5432/reachinbox?schema=public'),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_URL: z
    .string()
    .default('redis://localhost:6379')
    .transform((val) => {
      const match = val.match(/rediss?:\/\/\S+/i);
      return match ? match[0] : val.trim();
    }),

  ELASTICSEARCH_URL: z.string().url().default('http://localhost:9200'),
  ELASTICSEARCH_INDEX: z.string().min(1).default('reachinbox_emails'),

  JWT_SECRET: z.string().min(16).default('dev-insecure-jwt-secret-change-in-production'),
  SESSION_COOKIE_NAME: z.string().min(1).default('reachinbox_session'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_CALLBACK_URL: z.string().url().default('http://localhost:4000/api/auth/google/callback'),

  SLACK_CLIENT_ID: z.string().default(''),
  SLACK_CLIENT_SECRET: z.string().default(''),
  SLACK_REDIRECT_URI: z.string().url().default('http://localhost:4000/api/slack/callback'),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  MIN_DELAY_MS: z.coerce.number().int().nonnegative().default(2000),
  MAX_EMAILS_PER_HOUR: z.coerce.number().int().positive().default(100),
  EMAIL_QUEUE_NAME: z.string().min(1).default('email-dispatch-queue'),
  RUN_EMBEDDED_WORKER: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  ETHEREAL_USER: z.string().optional().default(''),
  ETHEREAL_PASS: z.string().optional().default(''),
  ETHEREAL_FROM_NAME: z.string().optional().default('ReachInbox Outreach'),
});

export type AppConfig = z.infer<typeof envSchema>;

export const config: AppConfig = envSchema.parse(process.env);
