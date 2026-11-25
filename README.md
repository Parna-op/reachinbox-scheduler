# ReachInbox Scheduler

A production-grade full-stack **Email Job Scheduler + Outreach Dashboard** built as a clean TypeScript monorepo (`backend/` + `frontend/` + `docker-compose.yml`).

> **Zero Cron Policy:** No `node-cron`, `agenda`, `crontab`, or polling loops are used anywhere. All future scheduling, minimum inter-email spacing, and hourly rate-limit overflow rescheduling are powered by **BullMQ delayed jobs** and **atomic Redis Lua scripts** backed by **PostgreSQL** persistence.

---

## Table of Contents

1. [Repository Structure](#repository-structure)
2. [Prerequisites & Infrastructure Setup](#prerequisites--infrastructure-setup)
3. [Environment Variables (Google OAuth, Slack OAuth, Ethereal, Services)](#environment-variables)
4. [Running Locally](#running-locally)
5. [Architecture & Design Deep Dive](#architecture--design-deep-dive)
   - [Scheduling & Staggered Bulk Dispatch](#scheduling--staggered-bulk-dispatch)
   - [Restart Persistence & Idempotency](#restart-persistence--idempotency)
   - [Redis Rate Limiting & Minimum Inter-Email Delay](#redis-rate-limiting--minimum-inter-email-delay)
   - [Concurrency & Multi-Sender Isolation](#concurrency--multi-sender-isolation)
   - [Behavior Under 1,000+ Lead Load](#behavior-under-1000-lead-load)
   - [Live Slack Rate-Limit Notifications](#live-slack-rate-limit-notifications)
   - [Elasticsearch Indexing & Search](#elasticsearch-indexing--search)
6. [Feature Checklist](#feature-checklist)
7. [Trade-offs & Production Considerations](#trade-offs--production-considerations)

---

## Repository Structure

```text
.
├── docker-compose.yml            # PostgreSQL 16, Redis 7 (AOF), Elasticsearch 8.15
├── package.json                  # Workspace scripts
├── .env.example                  # Complete environment variable template
├── backend/
│   ├── prisma/schema.prisma      # users, senders, email_jobs, slack_integrations
│   ├── src/
│   │   ├── app.ts                # Express app, CORS, Helmet, Bull Board (/admin/queues)
│   │   ├── server.ts             # API server entrypoint + startup recovery
│   │   ├── worker.ts             # Dedicated BullMQ worker entrypoint
│   │   ├── config/env.ts         # Zod-validated configuration
│   │   ├── middleware/auth.ts    # JWT cookie authentication middleware
│   │   ├── queue/
│   │   │   ├── emailQueue.ts     # BullMQ queue + bulk chunked enqueueing
│   │   │   └── emailWorker.ts    # Idempotent processor, rate-limit handling, recovery
│   │   ├── routes/
│   │   │   ├── auth.routes.ts    # Real Google OAuth 2.0, /me, /logout
│   │   │   ├── slack.routes.ts   # Real Slack OAuth 2.0, status, disconnect
│   │   │   ├── senders.routes.ts # Ethereal auto-provisioning & sender management
│   │   │   └── emails.routes.ts  # Bulk scheduling, listing, stats, ES search
│   │   └── services/
│   │       ├── rateLimiter.service.ts    # Atomic Redis Lua hourly + spacing limiter
│   │       ├── smtp.service.ts           # Pooled Nodemailer + Ethereal provisioning
│   │       ├── elasticsearch.service.ts  # Index mapping, bulk indexing, search
│   │       └── slack.service.ts          # Live DB-backed Slack notification sender
│   └── tests/                    # Vitest suite (auth, bulk schedule, worker, rate limit)
└── frontend/
    ├── src/
    │   ├── app/
    │   │   ├── login/page.tsx    # Real Google OAuth login screen
    │   │   └── dashboard/page.tsx# Scheduled/Sent tabs, search, stats, compose trigger
    │   ├── components/
    │   │   ├── TopHeader.tsx     # User profile, Slack connect/disconnect, Bull Board, logout
    │   │   ├── ComposeModal.tsx  # Campaign form + CSV/text lead parser & live count
    │   │   ├── EmailTable.tsx    # Status badges, skeletons, empty states, Ethereal links
    │   │   └── ToastProvider.tsx # Accessible toast notifications
    │   └── lib/
    │       ├── api.ts            # Typed credentialed API client
    │       └── leadParser.ts     # Client-side CSV/TSV/text email extractor & deduper
    └── tests/                    # Vitest tests for CSV/lead parsing
```

---

## Prerequisites & Infrastructure Setup

- **Node.js** >= 20 (tested on Node 22)
- **Docker & Docker Compose**

### 1. Start PostgreSQL, Redis, and Elasticsearch

```bash
cp .env.example .env
docker compose up -d
```

Verify all three services are healthy:

```bash
docker compose ps
```

- **PostgreSQL 16**: `localhost:5432` (database `reachinbox`, user `reachinbox`)
- **Redis 7**: `localhost:6379` (configured with `--appendonly yes` and `--maxmemory-policy noeviction` as required by BullMQ)
- **Elasticsearch 8.15**: `http://localhost:9200` (single-node, local dev security disabled)

---

## Environment Variables

Copy `.env.example` to `.env` in the repository root and configure the OAuth credentials:

| Variable | Description | Default / Example |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://reachinbox:reachinbox_pass@localhost:5432/reachinbox?schema=public` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `ELASTICSEARCH_URL` | Elasticsearch node URL | `http://localhost:9200` |
| `ELASTICSEARCH_INDEX` | Index name for email documents | `reachinbox_emails` |
| `PORT` | Backend Express API port | `4000` |
| `FRONTEND_URL` | Frontend origin for CORS & OAuth redirects | `http://localhost:3000` |
| `NEXT_PUBLIC_API_URL` | Backend base URL used by Next.js client | `http://localhost:4000` |
| `JWT_SECRET` | Secret for signing JWT session cookies & OAuth states | Strong random 32+ char string |
| `GOOGLE_CLIENT_ID` | Google Cloud OAuth 2.0 Client ID | `<id>.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth 2.0 Client Secret | `<secret>` |
| `GOOGLE_CALLBACK_URL` | Authorized redirect URI in Google Console | `http://localhost:4000/api/auth/google/callback` |
| `SLACK_CLIENT_ID` | Slack App Client ID | `<slack-client-id>` |
| `SLACK_CLIENT_SECRET` | Slack App Client Secret | `<slack-client-secret>` |
| `SLACK_REDIRECT_URI` | Slack OAuth v2 redirect URL | `http://localhost:4000/api/slack/callback` |
| `WORKER_CONCURRENCY` | Concurrent jobs processed by BullMQ worker | `5` |
| `MIN_DELAY_MS` | Minimum delay between sends per sender (ms) | `2000` |
| `MAX_EMAILS_PER_HOUR` | Default per-sender hourly cap | `100` |
| `RUN_EMBEDDED_WORKER` | Run worker inside API server (`true`/`false`) | `false` (run separate worker process) |
| `ETHEREAL_USER` / `ETHEREAL_PASS` | Optional fixed Ethereal account; auto-provisioned via `nodemailer.createTestAccount()` if blank | `""` |

### Google OAuth 2.0 Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials**.
2. Create an **OAuth 2.0 Client ID** (Web application).
3. Add Authorized JavaScript origin: `http://localhost:3000`.
4. Add Authorized redirect URI: `http://localhost:4000/api/auth/google/callback`.
5. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.

### Slack OAuth 2.0 Setup

1. Go to [Slack API](https://api.slack.com/apps) → **Create New App**.
2. Under **OAuth & Permissions**, add Redirect URL: `http://localhost:4000/api/slack/callback`.
3. Add Bot Token Scopes: `chat:write` and `incoming-webhook`.
4. Copy **Client ID** and **Client Secret** into `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` in `.env`.

### Ethereal Email Setup

- You can leave `ETHEREAL_USER` and `ETHEREAL_PASS` blank and click **Provision New Ethereal Account** in the Compose modal (or let `POST /api/emails/schedule` auto-provision one on your first send).
- Every delivered email stores its Ethereal preview URL (`nodemailer.getTestMessageUrl(info)`) so you can inspect rendered messages directly from the **Sent Emails** tab.

---

## Running Locally

### 1. Install Dependencies & Apply Database Schema

```bash
npm install
npm run prisma:generate
npm --workspace=backend run prisma:push
```

### 2. Run Backend API, BullMQ Worker, and Frontend

In three terminals (or set `RUN_EMBEDDED_WORKER=true` to run the worker inside the API process):

```bash
# Terminal 1: Backend API + Bull Board (/admin/queues)
npm run dev:backend

# Terminal 2: Dedicated BullMQ Email Worker
npm run dev:worker

# Terminal 3: Next.js Frontend Dashboard
npm run dev:frontend
```

- **Frontend Dashboard**: http://localhost:3000
- **Backend API Health**: http://localhost:4000/api/health
- **Bull Board Queue UI**: http://localhost:4000/admin/queues

### 3. Build & Run Tests

```bash
npm run build
npm test
```

---

## Architecture & Design Deep Dive

### Scheduling & Staggered Bulk Dispatch

When `POST /api/emails/schedule` receives a campaign (1 to 10,000 recipients):
1. Recipients are deduplicated case-insensitively.
2. Each lead gets a deterministic `idempotencyKey` (`SHA-256(userId + batchKey + recipient + index)`) and a staggered timestamp `scheduledAt = startTime + index * max(delayBetweenMs, MIN_DELAY_MS)`.
3. Records are inserted into PostgreSQL in batches of 500 via `createMany({ skipDuplicates: true })`.
4. Newly inserted jobs are added to BullMQ via `queue.addBulk` in chunks of 500 with `jobId: emailJob.id` and `delay = max(0, scheduledAt - now)`.
5. Documents are bulk-indexed into Elasticsearch for instant full-text prefix search.

### Restart Persistence & Idempotency

- **Redis Persistence:** Docker Compose runs Redis 7 with `--appendonly yes` and `noeviction`, preserving delayed BullMQ jobs across Redis restarts.
- **PostgreSQL Source of Truth & Boot Reconciliation:** On startup, both the API server and worker run `recoverPendingEmailJobs()`, which resets stale `processing` rows (>5 minutes old from an unclean crash) back to `scheduled` and re-enqueues any `scheduled` or `rate_limited` rows missing from BullMQ using deterministic `jobId: emailJob.id`.
- **Execution Idempotency:** Inside `processEmailJob()`, the worker checks `status === 'sent' || sentAt !== null` and then executes an atomic conditional SQL update (`UPDATE email_jobs SET status = 'processing' WHERE id = $1 AND status IN ('scheduled', 'rate_limited') AND sent_at IS NULL`). Only one worker can ever claim and transmit an email.

### Redis Rate Limiting & Minimum Inter-Email Delay

`backend/src/services/rateLimiter.service.ts` executes an atomic **Redis Lua script** (`acquireSendSlot`) before any SMTP send:
- **Hourly Counter:** Keyed by `rate_limit:sent:{senderId}:{hourWindow}` where `hourWindow = Math.floor(nowMs / 3600000)`.
- **Minimum Spacing:** Enforced via `rate_limit:next_allowed:{senderId}` so consecutive sends from the same sender are spaced by at least `MIN_DELAY_MS` even under `WORKER_CONCURRENCY > 1`.
- **Overflow Rescheduling (No Drops / No Failures):** When `currentCount >= hourlyLimit`, the Lua script scans future hour windows (`currentHour + 1 ... + 168`) and reserves an ordered slot in `rate_limit:reserved:{senderId}:{targetHour}`, computing `targetMs = targetHour * 3600000 + slotIdx * minDelayMs`.
- The worker updates the PostgreSQL row to `status = 'rate_limited'` with the new `scheduledAt`, updates Elasticsearch, fires a live Slack alert, and moves the BullMQ job cleanly using `job.moveToDelayed(targetMs, token)` + `throw new DelayedError()`.

### Concurrency & Multi-Sender Isolation

- `WORKER_CONCURRENCY` controls how many jobs the BullMQ worker processes concurrently.
- Rate-limit counters, spacing locks, and Nodemailer connection pools (`pool: true`) are keyed per `senderId`, so multiple senders operate independently in parallel while each sender strictly respects its own `MIN_DELAY_MS` and `MAX_EMAILS_PER_HOUR`.

### Behavior Under 1,000+ Lead Load

- **API Ingestion:** Batching PostgreSQL `createMany`, BullMQ `addBulk`, and Elasticsearch `bulk` in 500-item chunks keeps 1,000+ lead scheduling requests fast (<1s locally) and memory-bounded.
- **Worker Throughput:** BullMQ stores delayed jobs in a Redis sorted set (`ZSET`) and promotes them efficiently without busy-polling. If 1,000 jobs are scheduled with an hourly limit of 100, the first 100 dispatch in hour $H$, and jobs 101–1,000 automatically reserve ordered slots across hours $H+1 \dots H+9$ without failing or dropping any lead.

### Live Slack Rate-Limit Notifications

- Slack OAuth tokens and webhook URLs are stored in PostgreSQL (`slack_integrations`).
- Whenever a job hits the hourly rate limit, `notifySlackRateLimit()` reads the live `slack_integrations` row from PostgreSQL (never stale in-memory state).
- If Slack is disconnected (`isActive = false` or absent), notifications are gracefully skipped. Reconnecting via the dashboard immediately re-enables alerts on the next rate-limit event without restarting or redeploying the worker.
- A Redis `SET ... NX EX 3600` guard per `(userId, senderId, hourWindow)` prevents a 1,000-email burst from spamming 900 redundant Slack messages in the same hour.

### Elasticsearch Indexing & Search

- `email_jobs` are indexed into `reachinbox_emails` on creation and updated on `rate_limited`, `sent`, and `failed` transitions.
- `GET /api/emails/search` runs a scoped `bool` + `multi_match` (`phrase_prefix` across `recipient`, `subject`, `body`) query filtered by `userId` and tab statuses, then hydrates authoritative rows from PostgreSQL in ES rank order. If Elasticsearch is temporarily unreachable, it falls back to PostgreSQL `ILIKE` search and reports `searchEngine: "postgres-fallback"`.

---

## Feature Checklist

- [x] Docker Compose for PostgreSQL, Redis (AOF), and Elasticsearch
- [x] Real Google OAuth 2.0 login/callback + JWT `httpOnly` cookie + `/api/auth/me` + `/api/auth/logout`
- [x] Real Slack OAuth 2.0 connect/callback/status/disconnect stored in PostgreSQL
- [x] Prisma schema for `users`, `senders`, `email_jobs`, and `slack_integrations`
- [x] Zero cron libraries; BullMQ delayed jobs + startup DB-to-queue reconciler
- [x] Configurable `WORKER_CONCURRENCY`, `MIN_DELAY_MS`, and per-sender `MAX_EMAILS_PER_HOUR`
- [x] Atomic Redis Lua rate limiter rescheduling overflow into next hour window in order
- [x] Live Slack rate-limit alerts (graceful skip when disconnected; instant resume on reconnect)
- [x] Bulk scheduling for 1,000+ leads with idempotency keys & chunked DB/BullMQ/ES writes
- [x] Multiple Ethereal SMTP senders + Ethereal test account auto-provisioning + preview URLs
- [x] Elasticsearch indexing + `/api/emails/search` endpoint
- [x] Bull Board live queue dashboard at `/admin/queues`
- [x] Next.js + Tailwind dashboard with Google login, header profile/Slack/logout, Compose modal with CSV/TXT lead parser, Scheduled & Sent tabs, search, skeletons, empty states, and toasts

---

## Trade-offs & Production Considerations

1. **Bull Board Access Control:** `/admin/queues` is mounted directly for quick local queue observability as requested. In internet-facing production, wrap `/admin/queues` behind `requireAuth` or an internal VPN/admin middleware.
2. **Slack Alert Throttling:** Rate-limit alerts are deduplicated to one summary alert per `(sender, hourWindow)` via Redis so bulk campaigns exceeding an hourly cap don't hit Slack's 1 msg/sec API limit.
3. **Token Storage:** `accessToken` and `smtpPass` are stored directly in PostgreSQL for simplicity; in production, encrypt sensitive credentials at rest using envelope encryption (KMS / AES-256-GCM).
4. **Horizontal Scaling:** Because rate limits, spacing locks, and job claims are coordinated atomically in Redis Lua and PostgreSQL conditional updates, multiple worker replicas can be scaled horizontally without duplicate sends.
