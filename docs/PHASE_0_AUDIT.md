# PHASE 0 — COMPREHENSIVE CODEBASE AUDIT

**Project:** ReachInbox — Intelligent Email Delivery Platform  
**Audit Date:** 2026-11-17T11:13:26+05:30  
**Auditor Role:** Senior Backend Architect, PostgreSQL Engineer, Distributed Systems Engineer  
**Branch:** No git repository initialised (source extracted from archive)  
**Commit:** N/A  

---

## TABLE OF CONTENTS

1. [Executive Summary](#1-executive-summary)
2. [Folder Structure](#2-folder-structure)
3. [PostgreSQL Schema & Migrations](#3-postgresql-schema--migrations)
4. [Database Transaction Handling](#4-database-transaction-handling)
5. [Campaign APIs](#5-campaign-apis)
6. [Scheduling Implementation](#6-scheduling-implementation)
7. [BullMQ Queue Configuration](#7-bullmq-queue-configuration)
8. [Email Workers](#8-email-workers)
9. [Redis Rate Limiting](#9-redis-rate-limiting)
10. [Minimum Sending Delay](#10-minimum-sending-delay)
11. [Idempotency Implementation](#11-idempotency-implementation)
12. [SMTP Service](#12-smtp-service)
13. [Slack Integration](#13-slack-integration)
14. [Google Authentication](#14-google-authentication)
15. [Elasticsearch Indexing](#15-elasticsearch-indexing)
16. [Bull Board](#16-bull-board)
17. [Docker Compose](#17-docker-compose)
18. [Existing Backend Tests](#18-existing-backend-tests)
19. [README Instructions](#19-readme-instructions)
20. [Build & Compilation Results](#20-build--compilation-results)
21. [Security Audit](#21-security-audit)
22. [Consolidated Findings Matrix](#22-consolidated-findings-matrix)
23. [Phase 1 Database Implementation Plan](#23-phase-1-database-implementation-plan)

---

## 1. EXECUTIVE SUMMARY

The ReachInbox codebase is a **well-structured, feature-complete** email scheduling platform. The TypeScript source compiles cleanly (`tsc --noEmit` exits 0, `tsc` build exits 0) for both backend and frontend. The architecture correctly uses BullMQ delayed jobs (zero cron libraries), PostgreSQL as the source of truth, and Redis for rate limiting and send spacing via atomic Lua scripts.

**However, 18 findings require attention before production readiness.** The most critical gaps are:

| Severity | Count | Summary |
|----------|-------|---------|
| 🔴 CRITICAL | 4 | Fake SMTP fallback, no UNIQUE constraint for idempotency, SMTP credentials in plaintext DB, missing `ENCRYPTION_KEY` env var |
| 🟠 HIGH | 7 | Hardcoded worker concurrency, no migration version tracking, no restart recovery mechanism, test auth bypass risk, TLS validation disabled, `removeOnComplete: true` loses audit trail, no sender-level rate limiting |
| 🟡 MEDIUM | 5 | Config port mismatch, no formal test framework, no npm `test` script, missing `WORKER_CONCURRENCY` env var, Slack mock code in production path |
| 🔵 LOW | 2 | No git repo, npm audit vulnerabilities |

---

## 2. FOLDER STRUCTURE

### Existing File

```
Reachinbox-email-scheduler--main/
├── .gitignore
├── README.md
├── backend/
│   ├── .env.example
│   ├── .gitignore
│   ├── docker-compose.yml
│   ├── package.json
│   ├── tsconfig.json
│   ├── README.md
│   └── src/
│       ├── app.ts                          # Express app factory
│       ├── server.ts                       # Bootstrap + graceful shutdown
│       ├── auth/
│       │   └── passport.ts                 # Google OAuth strategy
│       ├── config/
│       │   └── index.ts                    # Centralised env config
│       ├── controllers/
│       │   ├── authController.ts
│       │   ├── campaignController.ts
│       │   ├── emailController.ts
│       │   ├── healthController.ts
│       │   ├── senderController.ts
│       │   └── slackAuthController.ts
│       ├── db/
│       │   ├── migrate.ts                  # SQL file runner
│       │   ├── postgres.ts                 # pg Pool singleton
│       │   ├── redis.ts                    # ioredis singleton
│       │   └── migrations/
│       │       ├── 001_initial_schema.sql
│       │       ├── 002_add_senders.sql
│       │       └── 003_add_slack_integrations.sql
│       ├── middleware/
│       │   ├── errorHandler.ts
│       │   ├── requestLogger.ts
│       │   └── requireAuth.ts
│       ├── queue/
│       │   └── emailQueue.ts               # BullMQ Queue definition
│       ├── routes/
│       │   ├── auth.ts
│       │   ├── campaigns.ts
│       │   ├── emails.ts
│       │   ├── health.routes.ts
│       │   ├── index.ts
│       │   ├── queues.ts                   # Bull Board
│       │   └── senders.ts
│       ├── scripts/                        # 17 manual test scripts
│       │   ├── loadTest.ts
│       │   ├── reindexEmails.ts
│       │   ├── testCampaign.ts
│       │   ├── testDb.ts
│       │   ├── testEmail.ts
│       │   ├── testEmailIndex.ts
│       │   ├── testMultipleSenders.ts
│       │   ├── testQueue.ts
│       │   ├── testRateLimiter.ts (file: testRateLimit.ts)
│       │   ├── testRecovery.ts
│       │   ├── testScheduleApi.ts
│       │   ├── testScheduleRetry.ts
│       │   ├── testSearch.ts
│       │   ├── testSendDelay.ts
│       │   ├── testSlack.ts
│       │   ├── testSlackIntegration.ts
│       │   └── testSlackOAuth.ts
│       ├── search/
│       │   └── elasticsearch.ts            # ES client singleton
│       ├── services/
│       │   ├── authService.ts
│       │   ├── campaignService.ts
│       │   ├── database.service.ts
│       │   ├── emailService.ts
│       │   ├── index.ts                    # Barrel export
│       │   ├── rateLimiter.ts (file: rateLimiter.service.ts)
│       │   ├── schedulingService.ts
│       │   ├── searchService.ts
│       │   ├── senderService.ts
│       │   ├── sendSpacing.ts (file: sendSpacing.service.ts)
│       │   ├── slackIntegrationService.ts (file: slackIntegration.service.ts)
│       │   └── slackService.ts
│       ├── types/
│       │   ├── db.types.ts
│       │   ├── express.d.ts
│       │   └── index.ts
│       ├── utils/
│       │   └── crypto.ts                   # AES-256-GCM encrypt/decrypt
│       └── workers/
│           └── emailWorker.ts              # BullMQ Worker
├── frontend/
│   ├── .env.example
│   ├── .gitignore
│   ├── index.html
│   ├── package.json
│   ├── postcss.config.js
│   ├── tailwind.config.js
│   ├── tsconfig.json / tsconfig.app.json / tsconfig.node.json
│   ├── vite.config.ts
│   └── src/
│       ├── App.tsx / App.css / main.tsx / index.css
│       ├── api/client.ts
│       ├── assets/ (hero.png, react.svg, vite.svg)
│       ├── components/ (ComposeModal, ComposeScheduled, Dashboard, Header, SenderManager, SummaryMetrics, UserMenu, ui/)
│       ├── context/ (AuthContext, ToastContext)
│       ├── pages/ (LoginView, ScheduledList, SearchView, SentListView)
│       ├── services/api.ts
│       └── types/index.ts
```

### Current Implementation
Well-organised monorepo with clear separation of concerns: `controllers/`, `services/`, `routes/`, `middleware/`, `workers/`, `queue/`, `db/`, `auth/`, `search/`, `scripts/`.

### Problem
No `docs/` directory existed. No `tests/` directory with formal test suites (Jest, Vitest, or Mocha). All "tests" are ad-hoc `scripts/*.ts` files requiring manual execution and live infrastructure.

### Risk
No CI-compatible test suite means regressions cannot be caught automatically before merge.

### Proposed Solution
Add a `tests/` directory with Jest or Vitest integration tests, plus unit tests for critical services. Create `docs/` for audit and implementation logs.

### Test Required
`npm test` should exit cleanly and produce a coverage report.

---

## 3. POSTGRESQL SCHEMA & MIGRATIONS

### Existing Files
- `backend/src/db/migrations/001_initial_schema.sql`
- `backend/src/db/migrations/002_add_senders.sql`
- `backend/src/db/migrations/003_add_slack_integrations.sql`
- `backend/src/db/migrate.ts`

### Current Implementation

**Tables (6 total):**

| Table | PK | FK | Key Columns |
|-------|----|----|-------------|
| `users` | UUID (pgcrypto) | — | `google_id`, `email` (UNIQUE) |
| `campaigns` | UUID | `user_id → users`, `sender_id → senders` | `subject`, `body`, `scheduled_at`, `hourly_limit`, `status` |
| `recipients` | UUID | `campaign_id → campaigns` | `email`, `name`, `status` |
| `email_logs` | UUID | `campaign_id → campaigns`, `recipient_id → recipients`, `sender_id → senders` | `status`, `sent_at`, `error_message` |
| `senders` | UUID | `user_id → users` | SMTP credentials (plaintext!) |
| `slack_integrations` | UUID | `user_id → users` (UNIQUE) | OAuth tokens (encrypted via AES-256-GCM) |
| `user_sessions` | auto-created by `connect-pg-simple` | — | Express session data |

**Indexes:**
- `idx_campaigns_user_id`, `idx_campaigns_status`, `idx_campaigns_scheduled_at`, `idx_campaigns_sender_id`
- `idx_recipients_campaign_id`, `idx_recipients_status`
- `idx_email_logs_campaign_id`, `idx_email_logs_recipient_id`, `idx_email_logs_status`, `idx_email_logs_sender_id`
- `idx_senders_user_id`
- `idx_slack_integrations_user_id`

**Migration runner** (`migrate.ts`): Sequential `.sql` file executor. Uses `IF NOT EXISTS` for idempotency. No version tracking table.

### Problems

| # | Problem | Risk | Proposed Solution |
|---|---------|------|-------------------|
| 3.1 | **No UNIQUE constraint on `email_logs(campaign_id, recipient_id)` for `status = 'sent'`** — idempotency relies solely on application-level `SELECT` before `INSERT`. | 🔴 **Race condition**: Two concurrent workers processing the same `(campaign_id, recipient_id)` can both pass the `SELECT` check and both `INSERT` a `'sent'` row, causing a **double send**. | Add `CREATE UNIQUE INDEX idx_email_logs_idempotency ON email_logs(campaign_id, recipient_id) WHERE status = 'sent'` (partial unique index). The worker's `INSERT` becomes a conflict-safe `INSERT ... ON CONFLICT DO NOTHING`. |
| 3.2 | **No migration version tracking table** — `migrate.ts` re-runs ALL SQL files every time. | 🟠 All migrations use `IF NOT EXISTS` so re-runs are safe, but `ALTER TABLE` statements in `002_add_senders.sql` use PL/pgSQL blocks to guard against double-add, which is fragile and verbose. | Add a `schema_migrations` table recording applied migration filenames. Only run unapplied migrations. |
| 3.3 | **SMTP credentials stored in plaintext** in `senders` table (`smtp_user`, `smtp_pass`). | 🔴 Database breach exposes all SMTP passwords. Slack tokens are encrypted at rest but SMTP passwords are not. Inconsistent security posture. | Encrypt `smtp_user` and `smtp_pass` with the same AES-256-GCM utility (`crypto.ts`) used for Slack tokens. Decrypt in `senderService` when building Nodemailer transporters. |
| 3.4 | **`campaigns.status` uses `VARCHAR` instead of an `ENUM` or `CHECK` constraint.** | 🟡 Any arbitrary string can be inserted as a campaign status. The TypeScript type `CampaignStatus` is not enforced at the DB level. | Add `CHECK (status IN ('draft', 'scheduled', 'sending', 'completed', 'failed'))`. Note: `db.types.ts` has `'sent'` in `CampaignStatus` but worker code sets `'completed'` — these are inconsistent. |
| 3.5 | **`CampaignStatus` type mismatch**: `db.types.ts` defines `'sent'` but `emailWorker.ts` writes `'completed'` to the database. | 🟠 TypeScript types do not match actual database values. | Align the TypeScript type to include `'completed'` and remove `'sent'`, or vice versa. |

### Test Required
- Verify partial unique index prevents duplicate `'sent'` rows.
- Verify encrypted SMTP credentials can be stored and retrieved.
- Verify migration version tracking skips already-applied migrations.

---

## 4. DATABASE TRANSACTION HANDLING

### Existing File
`backend/src/services/campaignService.ts`

### Current Implementation
`createCampaignWithRecipients()` uses explicit `BEGIN` / `COMMIT` / `ROLLBACK` with a dedicated pool client (`db.connect()`). Client is released in `finally` block. Side effects (Elasticsearch indexing, BullMQ scheduling, Slack notification) execute AFTER commit in isolated try/catch blocks.

### Problem
**All other database operations use the pool directly** (`db.query()`) without explicit transactions. This is acceptable for single-query operations but risky for the email worker which does `SELECT` → `INSERT` → `UPDATE` across multiple tables without a transaction boundary.

### Risk
🟠 If the worker crashes between inserting `email_logs` with `status = 'sent'` and updating `campaigns.status`, the campaign status becomes stale. Without the partial unique index (Finding 3.1), there is no database-level guard.

### Proposed Solution
Wrap the worker's post-send sequence (insert email_log → check remaining → update campaign status) in a transaction. The idempotency check and send itself must remain outside the transaction (we cannot hold a transaction open during SMTP I/O).

### Test Required
Simulate worker crash after email_log insert but before campaign status update. Verify recovery produces correct state.

---

## 5. CAMPAIGN APIs

### Existing Files
- `backend/src/controllers/campaignController.ts`
- `backend/src/routes/campaigns.ts`

### Current Implementation

| Endpoint | Method | Auth | Validation |
|----------|--------|------|------------|
| `/campaigns` | POST | ✅ requireAuth | subject (non-empty, ≤500), body (non-empty), hourly_limit (int 1-1000, default 5), scheduled_at (ISO 8601, must be future), recipients (non-empty array, valid emails, case-insensitive dedup), sender_id (required UUID) |
| `/campaigns` | GET | ✅ requireAuth | user_id scoped |
| `/campaigns/:id` | GET | ✅ requireAuth | user_id scoped |
| `/campaigns/:id` | PATCH | ✅ requireAuth | Same field validation as POST |
| `/campaigns/:id` | DELETE | ✅ requireAuth | user_id scoped, cascade delete |
| `/campaigns/:id/recipients` | GET | ✅ requireAuth | user_id scoped, LEFT JOIN email_logs |

### Problem
- **PATCH does not reschedule BullMQ jobs** when `scheduled_at` is updated. The original delayed jobs remain in Redis with the old delay.
- **DELETE does not remove BullMQ jobs** from the queue. Orphaned jobs will attempt processing, fail when campaign is not found, and exhaust retries.

### Risk
🟠 Editing `scheduled_at` on a campaign has no effect on when emails are actually sent. Deleting a campaign leaves ghost jobs in Redis that waste worker resources.

### Proposed Solution
When `scheduled_at` is updated via PATCH:
1. Remove all existing BullMQ jobs for that campaign.
2. Re-enqueue with the new delay.

When a campaign is deleted:
1. Remove all BullMQ jobs for that campaign from active/waiting/delayed states.

### Test Required
- PATCH `scheduled_at` → verify BullMQ jobs have updated delay.
- DELETE campaign → verify no orphaned jobs remain in Redis queue.

---

## 6. SCHEDULING IMPLEMENTATION

### Existing File
`backend/src/services/schedulingService.ts`

### Current Implementation
✅ **Correct**: Pure BullMQ delayed jobs. `delayMs = Math.max(0, scheduledAt.getTime() - Date.now())`. No cron, no polling, no setInterval. UTC epoch arithmetic. One job per recipient.

### Problem
**No restart recovery mechanism.** If the server crashes after PostgreSQL commit but before all BullMQ jobs are enqueued, some recipients will never receive their emails. There is no mechanism to scan for campaigns in `'scheduled'` or `'sending'` status and re-enqueue missing jobs.

### Risk
🟠 Partial campaign delivery after crash. BullMQ itself persists already-enqueued jobs across restarts (✅), but the enqueuing step is not atomic with the DB commit.

### Proposed Solution
Add a startup recovery routine:
1. On server boot, query all campaigns with `status IN ('scheduled', 'sending')`.
2. For each, check which recipients lack a `'sent'` entry in `email_logs`.
3. Re-enqueue only the missing recipients as BullMQ delayed jobs.
4. This must be idempotent — BullMQ job IDs should be deterministic (`campaign_${campaignId}_${recipientId}`) so duplicate enqueues are no-ops.

### Test Required
- Kill server mid-enqueue → restart → verify all recipients eventually get enqueued.
- Verify no duplicate jobs are created for recipients already in the queue.

---

## 7. BULLMQ QUEUE CONFIGURATION

### Existing File
`backend/src/queue/emailQueue.ts`

### Current Implementation

| Setting | Value |
|---------|-------|
| Queue name | `'email-queue'` |
| Attempts | 3 |
| Backoff | Exponential, 5000ms base |
| removeOnComplete | `true` |
| removeOnFail | `false` |
| Redis connection | `maxRetriesPerRequest: null` (BullMQ requirement) |
| TLS | `rejectUnauthorized: false` for `rediss://` URLs |

### Problems

| # | Problem | Risk | Proposed Solution |
|---|---------|------|-------------------|
| 7.1 | **`removeOnComplete: true`** deletes completed job metadata from Redis. | 🟠 No queue-level audit trail for completed jobs. Bull Board cannot display historical completed job data. | Change to `removeOnComplete: { count: 1000, age: 86400 }` to retain the last 1000 completed jobs for 24 hours. |
| 7.2 | **No deterministic job IDs.** Jobs are assigned auto-generated IDs. | 🟠 Cannot prevent duplicate job enqueues for the same `(campaignId, recipientId)` after a crash/restart. `emailQueue.add()` will create duplicate jobs. | Use `jobId: \`campaign_${campaignId}_${recipientId}\`` to make job IDs deterministic. BullMQ ignores `add()` for already-existing job IDs. |
| 7.3 | **TLS `rejectUnauthorized: false`** disables certificate validation for Redis connections. | 🟠 Man-in-the-middle risk in production. | Make configurable via env var `REDIS_TLS_REJECT_UNAUTHORIZED`. Default to `true` in production. |

### Test Required
- Verify deterministic job IDs prevent duplicate enqueues.
- Verify `removeOnComplete` retention settings work with Bull Board.

---

## 8. EMAIL WORKERS

### Existing File
`backend/src/workers/emailWorker.ts`

### Current Implementation
Worker processes jobs from `email-queue` with concurrency 2. Processing pipeline:
1. Load campaign + recipient from PostgreSQL
2. Load + verify sender ownership
3. Idempotency check (`email_logs` SELECT)
4. Rate limit check (Redis Lua)
5. Template interpolation (`{{name}}`)
6. Send spacing check (Redis Lua)
7. Send email (Nodemailer)
8. Record success in `email_logs`
9. Index in Elasticsearch
10. Update campaign status

Graceful shutdown on SIGINT/SIGTERM.

### Problems

| # | Problem | Risk | Proposed Solution |
|---|---------|------|-------------------|
| 8.1 | **Worker concurrency is hardcoded to `2`**. | 🟡 Cannot scale workers without code changes. Requirement states "configurable worker concurrency." | Read from `config.app.workerConcurrency` backed by `WORKER_CONCURRENCY` env var, defaulting to 2. |
| 8.2 | **`simulateFailure` test hook** is in production code path. | 🟡 If job payload somehow includes `simulateFailure: true`, it will intentionally fail in production. | Gate behind `NODE_ENV !== 'production'` check. |
| 8.3 | **Inline worker import in `server.ts`** runs worker and API in same process by default. | 🟡 Worker crash can take down the API. README documents separate `npm run worker` process but server.ts auto-imports it unless `ENABLE_INLINE_WORKER=false`. | Document clearly. Consider defaulting to `false` in production. |

### Test Required
- Set `WORKER_CONCURRENCY=10` → verify worker processes 10 concurrent jobs.
- Verify `simulateFailure` is ignored in production mode.

---

## 9. REDIS RATE LIMITING

### Existing File
`backend/src/services/rateLimiter.ts`

### Current Implementation
✅ **Correct**: Atomic Redis Lua script with fixed-window counter per campaign. Key: `rate-limit:campaign:${campaignId}`. Uses `GET` → `INCR` → `EXPIRE` atomically. Returns `{allowed, waitMs}`. When rate-limited, worker calls `job.moveToDelayed()` + `throw new DelayedError()` — does NOT consume a retry attempt.

### Problem
**Rate limiting is per-campaign only, not per-sender.** Requirement #10 states: "Implement shared sender-level rate limiting." Multiple campaigns using the same sender can collectively exceed SMTP provider limits.

### Risk
🟠 If 5 campaigns share the same sender with `hourly_limit: 100` each, the sender actually sends 500 emails/hour, potentially triggering SMTP provider blocks or IP blacklisting.

### Proposed Solution
Add a sender-level rate limiter alongside the existing campaign-level one:
1. Key: `rate-limit:sender:${senderId}`
2. Configurable limit per sender (new column `hourly_limit` on `senders` table, or a global default).
3. Worker checks sender rate limit AFTER campaign rate limit.
4. If sender-limited, delay job via same `moveToDelayed` + `DelayedError` pattern.

### Test Required
- 3 campaigns sharing 1 sender, each with hourly_limit 10, sender limit 15 → verify total sends capped at 15/hour.

---

## 10. MINIMUM SENDING DELAY

### Existing File
`backend/src/services/sendSpacing.ts`

### Current Implementation
✅ **Correct**: Atomic Redis Lua script enforcing global minimum inter-email delay. Key: `email-send:global:last-send`. Default delay: 2000ms (configurable via `EMAIL_SEND_DELAY_MS` env var). When spacing not met, worker delays job via `moveToDelayed` + `DelayedError`.

### Problem
None — implementation is correct and meets requirements. The delay is configurable via environment variable with safe integer parsing and fallback.

### Risk
Low. The 1-hour TTL on the Redis key (`EX 3600`) prevents zombie state.

### Proposed Solution
No changes needed.

### Test Required
Existing `npm run send-delay:test` script validates this. Add formal test to CI suite.

---

## 11. IDEMPOTENCY IMPLEMENTATION

### Existing File
`backend/src/workers/emailWorker.ts` (lines 65-73)

### Current Implementation
Before sending, worker queries: `SELECT id FROM email_logs WHERE campaign_id = $1 AND recipient_id = $2 AND status = 'sent' LIMIT 1`. If a row exists, the job completes without sending.

### Problem
🔴 **Application-level check only. No database-level UNIQUE constraint.** Two workers processing the same recipient concurrently can both pass the `SELECT` and both send.

### Risk
**Double email delivery.** This is the most critical defect in the codebase.

### Proposed Solution
1. Add partial unique index: `CREATE UNIQUE INDEX idx_email_logs_idempotency ON email_logs(campaign_id, recipient_id) WHERE status = 'sent'`.
2. Change the worker's success INSERT to: `INSERT INTO email_logs (...) VALUES (...) ON CONFLICT (campaign_id, recipient_id) WHERE status = 'sent' DO NOTHING RETURNING id`.
3. If `RETURNING` yields no row, another worker already recorded the send — skip silently.

This provides **database-level idempotency protection** even under concurrent processing.

### Test Required
- Two workers simultaneously processing the same (campaign, recipient) → only one email sent, one `'sent'` row in email_logs.

---

## 12. SMTP SERVICE

### Existing File
`backend/src/services/emailService.ts`

### Current Implementation
Three-tier delivery cascade:
1. **Tier 1**: Custom sender SMTP via cached transporter (SHA-256 credential hashing for cache invalidation).
2. **Tier 2**: Fallback to system default Ethereal SMTP transporter.
3. **Tier 3**: If both fail (e.g., cloud provider blocks outbound SMTP), generates a **fake message ID and simulated Ethereal preview URL**.

### Problem
🔴 **Tier 3 fakes SMTP success.** Requirement #9 states: "Do not fake SMTP success." The Tier 3 fallback generates a synthetic `messageId` (`<randomHex@reachinbox.email>`) and a hardcoded preview URL pattern. This fake result is passed back to the worker, which records `'sent'` in `email_logs` — marking an email as delivered when it was never actually sent.

### Risk
**Data integrity violation.** Users see emails as "sent" when they were never delivered. `email_logs` contains fabricated records. This is fundamentally incompatible with the requirement for genuine delivery reporting.

### Proposed Solution
1. Remove Tier 3 entirely.
2. When both Tier 1 and Tier 2 fail, **throw the error** and let BullMQ retry with exponential backoff.
3. After exhausting retries, the job lands in the failed state (which is already retained with `removeOnFail: false`), and the email_log records `'failed'` with the actual error message.
4. Optionally send a Slack notification for persistent SMTP failures.

### Test Required
- When Tier 1 and Tier 2 both fail, verify the job is marked as `'failed'` (not `'sent'`).
- Verify no synthetic message IDs are generated.

---

## 13. SLACK INTEGRATION

### Existing Files
- `backend/src/services/slackService.ts`
- `backend/src/services/slackIntegrationService.ts`
- `backend/src/controllers/slackAuthController.ts`

### Current Implementation
- **OAuth 2.0 flow**: Real Slack OAuth with CSRF state validation, `incoming-webhook` scope.
- **Token storage**: Encrypted at rest (AES-256-GCM) in `slack_integrations` table.
- **Webhook dispatch**: Validates `https://hooks.slack.com/services/` prefix. 5-second timeout.
- **Deduplication**: Redis key `slack:ratelimit:notified:${campaignId}:${windowEpoch}` with `NX` flag prevents duplicate alerts per rate-limit window.
- **Error isolation**: All Slack errors caught internally — never crashes email sending.

### Problems

| # | Problem | Risk | Proposed Solution |
|---|---------|------|-------------------|
| 13.1 | **Mock code exchange in production path.** `slackAuthController.ts` lines 82-103 check `code.startsWith('mock-code-')` and bypass real Slack API. | 🟡 In production, if someone crafts a request with `code=mock-code-valid`, they can inject a fake Slack connection with a mock webhook URL for any authenticated user. | Gate mock code path behind `process.env.NODE_ENV === 'test'` or `process.env.ALLOW_TEST_AUTH === 'true'`. |
| 13.2 | **`testState` exported from `slackService.ts`** — mutable test state object accessible in production. | 🟡 Leaks internal testing state. | Gate behind `NODE_ENV !== 'production'`. |

### Test Required
- Verify mock code path is blocked in production mode.
- Verify real Slack OAuth flow with valid credentials.

---

## 14. GOOGLE AUTHENTICATION

### Existing Files
- `backend/src/auth/passport.ts`
- `backend/src/controllers/authController.ts`
- `backend/src/routes/auth.ts`

### Current Implementation
✅ **Correct**: Real Google OAuth 2.0 via `passport-google-oauth20`. Scopes: `openid`, `profile`, `email`. Sessions stored in PostgreSQL (`connect-pg-simple` → `user_sessions` table with `createTableIfMissing: true`). Only user UUID stored in session cookie. Tokens discarded (not persisted). 3-step lookup: by google_id → by email → create new.

### Problem
- `config.google.clientId` defaults to `'placeholder-google-client-id'` if env var is unset. The OAuth strategy will be initialised with invalid credentials and fail silently at runtime.
- `requireAuth.ts` has a test bypass when `ALLOW_TEST_AUTH === 'true'` — allows arbitrary user impersonation via `x-test-user-id` header.

### Risk
🟠 If `ALLOW_TEST_AUTH` is accidentally set in production, any request with `x-test-user-id` header bypasses authentication entirely.

### Proposed Solution
- Refuse to start the server if `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` are placeholder values in production.
- Refuse to start if `ALLOW_TEST_AUTH === 'true'` and `NODE_ENV === 'production'`.

### Test Required
- Verify server refuses to start with placeholder Google credentials in production mode.
- Verify `x-test-user-id` header is ignored when `ALLOW_TEST_AUTH` is not set.

---

## 15. ELASTICSEARCH INDEXING

### Existing Files
- `backend/src/search/elasticsearch.ts`
- `backend/src/services/searchService.ts`

### Current Implementation
- **Index**: `reachinbox-emails` with keyword and text field mappings.
- **Deterministic doc IDs**: `${campaignId}_${recipientId}` — prevents duplicate documents.
- **Bulk indexing** on campaign creation.
- **Status update** (`indexEmailAsSent`) after successful send.
- **PostgreSQL fallback**: If Elasticsearch is offline, `searchEmails()` falls back to SQL `ILIKE` queries.
- **User scoping**: All queries enforce `{ term: { userId } }`.

### Problem
None critical. Implementation is robust with graceful degradation.

### Risk
Low. Elasticsearch failures are caught and logged without affecting email delivery.

### Proposed Solution
No changes needed. Consider adding a health check for Elasticsearch in the `/health` endpoint (currently only checks PostgreSQL and Redis).

### Test Required
Existing `npm run search:test` validates this. Port to formal test suite.

---

## 16. BULL BOARD

### Existing File
`backend/src/routes/queues.ts`

### Current Implementation
✅ Correct: `@bull-board/express` with `BullMQAdapter`. Mounted at `/admin/queues`. Shows active, waiting, delayed, completed, and failed jobs.

### Problem
- **No authentication** on `/admin/queues`. Anyone who can reach the server can view and manipulate the queue dashboard.
- Comment says "development only" but no guard prevents access in production.

### Risk
🟠 Information disclosure and potential queue manipulation in production.

### Proposed Solution
Add `requireAuth` middleware or a separate admin auth guard to the Bull Board route. In production, consider disabling it entirely.

### Test Required
- Verify `/admin/queues` returns 401 for unauthenticated requests.

---

## 17. DOCKER COMPOSE

### Existing File
`backend/docker-compose.yml`

### Current Implementation
✅ Correct: PostgreSQL 16-alpine, Redis 7-alpine, Elasticsearch 8.12.0. All with named volumes for data persistence, health checks, and `restart: unless-stopped`.

### Problem
- **Redis has no persistence configuration explicitly set.** The default Docker Redis image uses RDB snapshots, but `appendonly` is not enabled. BullMQ delayed jobs may be lost if the Redis container crashes between RDB snapshots.
- **No backend/frontend containers** defined — only infrastructure services.

### Risk
🟠 BullMQ delayed jobs (the scheduling mechanism) can be lost on Redis container crash.

### Proposed Solution
Add `command: redis-server --appendonly yes --appendfsync everysec` to the Redis service to enable AOF persistence. This ensures delayed jobs survive Redis restarts.

### Test Required
- Kill Redis container → restart → verify delayed BullMQ jobs still exist.

---

## 18. EXISTING BACKEND TESTS

### Existing Files
17 scripts in `backend/src/scripts/`

### Current Implementation
All "tests" are **manual integration scripts** (`ts-node` scripts) that require live PostgreSQL, Redis, and Elasticsearch. They are NOT automated test suites — no test framework (Jest, Vitest, Mocha), no assertions library, no test runner, no coverage reporting.

| Script | What It Tests |
|--------|---------------|
| `testDb.ts` | PostgreSQL connectivity, schema, FK cascades |
| `testQueue.ts` | BullMQ enqueue/dequeue, delayed jobs |
| `testEmail.ts` | Nodemailer SMTP dispatch |
| `testRateLimit.ts` | Redis Lua rate limiter |
| `testRecovery.ts` | Worker crash/restart |
| `testSlack.ts` | Slack webhook delivery |
| `testSlackIntegration.ts` | Rate limit → Slack alert dedup |
| `testSlackOAuth.ts` | OAuth flow with mock codes |
| `testSearch.ts` | Elasticsearch CRUD + fallback |
| `testMultipleSenders.ts` | Multi-sender routing |
| `testSendDelay.ts` | Send spacing enforcement |
| `testScheduleApi.ts` | Scheduled campaign API |
| `testScheduleRetry.ts` | Scheduled job recovery |
| `loadTest.ts` | 1000-job stress test |

### Problem
🟡 No `npm test` script. No formal test framework. No CI compatibility. No coverage metrics. No unit tests (only integration scripts that require all infrastructure running).

### Risk
Regressions cannot be detected automatically. PRs cannot be gated on test results.

### Proposed Solution
1. Install Jest + `ts-jest` (or Vitest).
2. Create unit tests for critical pure-logic functions (rate limiter, send spacing, scheduling, idempotency).
3. Create integration tests using `testcontainers` for PostgreSQL and Redis.
4. Add `"test": "jest"` to `package.json` scripts.

### Test Required
`npm test` exits 0 with meaningful test coverage.

---

## 19. README INSTRUCTIONS

### Existing Files
- Root `README.md`
- `backend/README.md`

### Current Implementation
✅ Comprehensive documentation: architecture diagram (Mermaid), quick start guide, environment variable reference, API reference, test matrix, security architecture notes.

### Problem
- Backend README documents phases but references limitations (e.g., "BullMQ delayed jobs are not deleted when a campaign is deleted") that should be tracked as issues.
- Root README does not mention `ENCRYPTION_KEY` env var.
- `.env.example` does not include `ENCRYPTION_KEY`.

### Risk
🟡 `ENCRYPTION_KEY` defaults to `config.session.secret` which defaults to a hardcoded string `'reachinbox-default-secret-key-32chars-min!!'`. All Slack token encryption in production would use this known default.

### Proposed Solution
Add `ENCRYPTION_KEY` to `.env.example` with generation instructions. Refuse to start in production without a proper `ENCRYPTION_KEY`.

### Test Required
- Verify server refuses to start in production with default encryption key.

---

## 20. BUILD & COMPILATION RESULTS

### Commands Executed

| Command | Working Directory | Exit Code | Result |
|---------|-------------------|-----------|--------|
| `npm install` | `backend/` | 0 | 244 packages, 6 vulnerabilities (1 moderate, 4 high, 1 critical) |
| `npm install` | `frontend/` | 0 | 60 packages, 2 high vulnerabilities |
| `npx tsc --noEmit` | `backend/` | 0 | ✅ Clean — zero TypeScript errors |
| `npx tsc` | `backend/` | 0 | ✅ Clean build to `dist/` |
| `npx tsc -b --noEmit` | `frontend/` | 0 | ✅ Clean — zero TypeScript errors |

### npm audit Summary

**Backend (6 vulnerabilities):**
- `body-parser` < 1.20.9 — DoS via trailing bytes (HIGH)
- `brace-expansion` ≤ 1.1.20 — DoS via recursion (HIGH)
- `nodemailer` ≤ 10.1.3 — 14 advisories including address parsing bypass, DoS, credential disclosure (HIGH)
- `proxy-addr` 1.1.0–2.0.7 — IP spoofing via IPv4-mapped IPv6 (CRITICAL)
- `qs` 2.2.5–6.16.0 — Array limit bypass, DoS (MODERATE)
- `undici` ≤ 6.29.0 — 8 advisories including TLS bypass, DoS (HIGH)

**Frontend (2 vulnerabilities):**
- `source-map-js` 1.0.0–1.2.1 — DoS via indexed source-map (HIGH)
- `vite` 8.2.0–8.2.2 — Command execution, path traversal (HIGH)

### Cron Library Search
✅ **CONFIRMED: Zero cron libraries.** `Select-String` scan for `cron|node-cron|agenda|crontab` across all `.ts` files found only comments explicitly stating cron is NOT used.

---

## 21. SECURITY AUDIT

| # | Category | Finding | Severity | Location |
|---|----------|---------|----------|----------|
| S1 | Authentication Bypass | `requireAuth.ts` allows `x-test-user-id` bypass when `ALLOW_TEST_AUTH=true` | 🟠 HIGH | `middleware/requireAuth.ts:11-23` |
| S2 | TLS Validation | `rejectUnauthorized: false` on Redis TLS and all Nodemailer transporters | 🟠 HIGH | `emailQueue.ts:21`, `emailService.ts:20,101`, `postgres.ts:11` |
| S3 | Fake Delivery | Tier 3 SMTP fallback generates synthetic delivery records | 🔴 CRITICAL | `emailService.ts:167-178` |
| S4 | Credential Exposure | SMTP passwords stored in plaintext in `senders` table | 🔴 CRITICAL | `002_add_senders.sql`, `senderService.ts` |
| S5 | Default Secrets | Session secret and encryption key have hardcoded defaults | 🟠 HIGH | `config/index.ts:64` |
| S6 | Mock in Production | Slack OAuth mock code exchange not gated by environment | 🟡 MEDIUM | `slackAuthController.ts:82-103` |
| S7 | Admin Dashboard | Bull Board `/admin/queues` has no authentication | 🟠 HIGH | `routes/queues.ts`, `routes/index.ts` |
| S8 | npm Vulnerabilities | 6 backend + 2 frontend known vulnerabilities | 🔵 LOW | `npm audit` output |

---

## 22. CONSOLIDATED FINDINGS MATRIX

| ID | Area | File | Current State | Problem | Severity | Proposed Fix |
|----|------|------|---------------|---------|----------|-------------|
| F01 | Idempotency | `001_initial_schema.sql` | App-level SELECT check only | No DB UNIQUE constraint — race condition allows double send | 🔴 CRITICAL | Add partial unique index on `email_logs(campaign_id, recipient_id) WHERE status = 'sent'` |
| F02 | SMTP | `emailService.ts` | Tier 3 generates fake delivery | Fakes SMTP success, violates requirement #9 | 🔴 CRITICAL | Remove Tier 3; throw error and let BullMQ retry |
| F03 | Credentials | `senders` table | SMTP passwords in plaintext | DB breach exposes all SMTP credentials | 🔴 CRITICAL | Encrypt with AES-256-GCM (same as Slack tokens) |
| F04 | Encryption | `.env.example` | Missing `ENCRYPTION_KEY` | Defaults to hardcoded session secret | 🔴 CRITICAL | Add to `.env.example`; refuse to start in prod without it |
| F05 | Rate Limiting | `rateLimiter.ts` | Per-campaign only | No shared sender-level rate limiting (requirement #10) | 🟠 HIGH | Add sender-level rate limiter with configurable limits |
| F06 | Recovery | `server.ts` | No startup recovery | Crash between DB commit and BullMQ enqueue loses jobs | 🟠 HIGH | Startup scan for `'scheduled'`/`'sending'` campaigns, re-enqueue missing |
| F07 | Queue Config | `emailQueue.ts` | Auto-generated job IDs | Cannot prevent duplicate enqueues after restart | 🟠 HIGH | Use deterministic job IDs: `campaign_${cid}_${rid}` |
| F08 | Queue Config | `emailQueue.ts` | `removeOnComplete: true` | No historical completed job data in Bull Board | 🟠 HIGH | Use `{ count: 1000, age: 86400 }` |
| F09 | Schema | `db.types.ts` vs worker | `CampaignStatus` has `'sent'`, worker writes `'completed'` | Type mismatch | 🟠 HIGH | Align TypeScript types with actual DB values |
| F10 | Migrations | `migrate.ts` | Re-runs all SQL files | No version tracking table | 🟠 HIGH | Add `schema_migrations` tracking table |
| F11 | Auth Bypass | `requireAuth.ts` | Test bypass in production | `ALLOW_TEST_AUTH=true` enables arbitrary impersonation | 🟠 HIGH | Block in production environment |
| F12 | Concurrency | `emailWorker.ts` | Hardcoded `concurrency: 2` | Not configurable (requirement #11) | 🟡 MEDIUM | Read from `WORKER_CONCURRENCY` env var |
| F13 | Campaign API | `campaignController.ts` | PATCH/DELETE don't sync BullMQ | Orphaned/stale delayed jobs in Redis | 🟡 MEDIUM | Sync BullMQ queue on PATCH/DELETE |
| F14 | Testing | `scripts/` | Manual integration scripts | No formal test framework, no `npm test`, no CI | 🟡 MEDIUM | Add Jest/Vitest with unit + integration tests |
| F15 | Slack Mock | `slackAuthController.ts` | Mock code in production path | Fake Slack connection possible | 🟡 MEDIUM | Gate behind `NODE_ENV === 'test'` |
| F16 | Config | `config/index.ts` | Default port `5000` | `.env.example` says `5001` | 🟡 MEDIUM | Align default to `5001` |
| F17 | Redis | `docker-compose.yml` | No AOF persistence | Delayed jobs lost on Redis crash | 🟠 HIGH | Add `--appendonly yes` |
| F18 | Git | Root directory | No `.git` initialized | No version control | 🔵 LOW | Initialize git repo |

---

## 23. PHASE 1 DATABASE IMPLEMENTATION PLAN

> [!IMPORTANT]
> **This plan requires your explicit approval before any file is modified.**

### Phase 1 Scope: Database-Level Hardening

**Objective:** Eliminate all CRITICAL findings and establish the database as a trustworthy source of truth.

#### Step 1: New Migration `004_add_idempotency_constraint.sql`
```sql
-- Partial unique index guaranteeing at most one 'sent' record per (campaign, recipient)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_email_logs_idempotency
  ON email_logs(campaign_id, recipient_id)
  WHERE status = 'sent';
```

#### Step 2: New Migration `005_add_schema_migrations.sql`
```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename VARCHAR PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
Update `migrate.ts` to record applied migrations and skip already-applied ones.

#### Step 3: New Migration `006_encrypt_sender_credentials.sql`
No DDL needed — `smtp_user` and `smtp_pass` columns remain `VARCHAR`. The encryption happens at the application layer:
- Encrypt on INSERT/UPDATE in `senderService.ts`
- Decrypt on SELECT in `senderService.ts` and `emailWorker.ts`
- Run a one-time data migration script to encrypt existing plaintext values.

#### Step 4: Fix `CampaignStatus` Type Alignment
Update `db.types.ts` to replace `'sent'` with `'completed'` in `CampaignStatus`.

#### Step 5: Update Worker INSERT for Idempotency
Change `emailWorker.ts` success INSERT to:
```sql
INSERT INTO email_logs (campaign_id, recipient_id, sender_id, status, sent_at)
VALUES ($1, $2, $3, 'sent', NOW())
ON CONFLICT (campaign_id, recipient_id) WHERE status = 'sent'
DO NOTHING
RETURNING id
```

#### Step 6: Add `ENCRYPTION_KEY` to `.env.example`

#### Step 7: Remove Fake SMTP Tier 3 Fallback
Remove the synthetic message ID/preview URL generation from `emailService.ts`. Let errors propagate for BullMQ retry.

#### Step 8: Add Configurable Worker Concurrency
Read `WORKER_CONCURRENCY` from env, default to 2.

### Phase 1 Deliverables
- 2 new migration files
- Updated `migrate.ts` with version tracking
- Updated `emailWorker.ts` with conflict-safe INSERT
- Updated `emailService.ts` without fake fallback
- Updated `senderService.ts` with credential encryption
- Updated `db.types.ts` with correct status enum
- Updated `config/index.ts` with `workerConcurrency`
- Updated `.env.example` with new env vars

### Phase 1 Verification
- `npm run db:migrate` applies only new migrations
- Concurrent worker test: same (campaign, recipient) → exactly one `'sent'` row
- Encrypted credentials round-trip test
- Worker concurrency test with configurable count
- SMTP failure test: no fake records

---

**END OF PHASE 0 AUDIT**

*Awaiting approval to proceed with Phase 1 implementation.*
