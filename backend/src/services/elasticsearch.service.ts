import { Client } from '@elastic/elasticsearch';
import type { EmailJob } from '@prisma/client';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

export const esClient = new Client({
  node: config.ELASTICSEARCH_URL,
  requestTimeout: 5000,
});

export interface EmailSearchDocument {
  id: string;
  userId: string;
  senderId: string;
  recipient: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  previewUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

let indexInitialized = false;

export async function ensureEmailIndex(): Promise<boolean> {
  if (indexInitialized) return true;

  try {
    const exists = await esClient.indices.exists({ index: config.ELASTICSEARCH_INDEX });
    if (!exists) {
      await esClient.indices.create({
        index: config.ELASTICSEARCH_INDEX,
        mappings: {
          properties: {
            id: { type: 'keyword' },
            userId: { type: 'keyword' },
            senderId: { type: 'keyword' },
            recipient: {
              type: 'text',
              fields: { keyword: { type: 'keyword' } },
            },
            subject: {
              type: 'text',
              fields: { keyword: { type: 'keyword' } },
            },
            body: { type: 'text' },
            status: { type: 'keyword' },
            scheduledAt: { type: 'date' },
            sentAt: { type: 'date' },
            previewUrl: { type: 'keyword', index: false },
            error: { type: 'text' },
            createdAt: { type: 'date' },
            updatedAt: { type: 'date' },
          },
        },
      });
      logger.info({ index: config.ELASTICSEARCH_INDEX }, 'Created Elasticsearch email index');
    }
    indexInitialized = true;
    return true;
  } catch (err) {
    logger.warn({ err }, 'Elasticsearch unavailable during index initialization');
    return false;
  }
}

export function toSearchDocument(job: EmailJob): EmailSearchDocument {
  return {
    id: job.id,
    userId: job.userId,
    senderId: job.senderId,
    recipient: job.recipient,
    subject: job.subject,
    body: job.body,
    status: job.status,
    scheduledAt: job.scheduledAt.toISOString(),
    sentAt: job.sentAt ? job.sentAt.toISOString() : null,
    previewUrl: job.previewUrl,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export async function indexEmailJob(job: EmailJob): Promise<void> {
  try {
    await ensureEmailIndex();
    await esClient.index({
      index: config.ELASTICSEARCH_INDEX,
      id: job.id,
      document: toSearchDocument(job),
    });
  } catch (err) {
    logger.warn({ err, emailJobId: job.id }, 'Failed to index email job in Elasticsearch');
  }
}

export async function bulkIndexEmailJobs(jobs: EmailJob[]): Promise<void> {
  if (jobs.length === 0) return;

  try {
    await ensureEmailIndex();
    const chunkSize = 500;
    for (let i = 0; i < jobs.length; i += chunkSize) {
      const slice = jobs.slice(i, i + chunkSize);
      const operations = slice.flatMap((job) => [
        { index: { _index: config.ELASTICSEARCH_INDEX, _id: job.id } },
        toSearchDocument(job),
      ]);
      const resp = await esClient.bulk({ operations });
      if (resp.errors) {
        logger.warn({ count: slice.length }, 'Partial errors during Elasticsearch bulk indexing');
      }
    }
  } catch (err) {
    logger.warn({ err, count: jobs.length }, 'Failed to bulk index email jobs in Elasticsearch');
  }
}

export async function searchEmailJobsInEs(params: {
  userId: string;
  query?: string;
  statuses?: string[];
  page: number;
  limit: number;
  sortField: 'scheduledAt' | 'sentAt';
  sortOrder: 'asc' | 'desc';
}): Promise<{ ids: string[]; total: number }> {
  await ensureEmailIndex();

  const must: Record<string, unknown>[] = [];
  const filter: Record<string, unknown>[] = [{ term: { userId: params.userId } }];

  if (params.statuses && params.statuses.length > 0) {
    filter.push({ terms: { status: params.statuses } });
  }

  const trimmed = params.query?.trim();
  if (trimmed) {
    must.push({
      multi_match: {
        query: trimmed,
        fields: ['recipient^3', 'subject^2', 'body'],
        type: 'phrase_prefix',
      },
    });
  }

  const from = (params.page - 1) * params.limit;
  const result = await esClient.search<EmailSearchDocument>({
    index: config.ELASTICSEARCH_INDEX,
    from,
    size: params.limit,
    query: {
      bool: {
        must: must.length > 0 ? must : [{ match_all: {} }],
        filter,
      },
    },
    sort: [
      {
        [params.sortField]: {
          order: params.sortOrder,
          missing: '_last',
        },
      },
      { createdAt: { order: 'desc' } },
    ],
  });

  const hits = result.hits.hits;
  const total =
    typeof result.hits.total === 'number'
      ? result.hits.total
      : (result.hits.total?.value ?? hits.length);

  return {
    ids: hits.map((hit) => hit._id).filter((id): id is string => Boolean(id)),
    total,
  };
}
