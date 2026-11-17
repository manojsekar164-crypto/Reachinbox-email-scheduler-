# ANTIGRAVITY WORKING BRIEF — REACHINBOX EMAIL DELIVERY PLATFORM

**Date:** 2026-11-17  
**Version:** 1.0.0  
**Repository:** `https://github.com/manojsekar164-crypto/Reachinbox-email-scheduler-.git`  
**Active Development Branch:** `feat/database-foundation`  
**Working Directory:** `D:\Devops projects\ReachInbox-canonical`  
**Role:** Senior PostgreSQL Architect, Database Security Engineer, and Distributed Systems Engineer  

---

## 1. System Mission & Core Constraints

ReachInbox is an intelligent, high-throughput email delivery and campaign scheduling platform. The mission is to transform the existing codebase into a bulletproof, production-grade distributed system following the 13-stage official development roadmap:

- **Stage 0:** Existing project audit (Completed)
- **Stage 1:** Database migrations and delivery model (CURRENT STAGE)
- **Stage 2:** Transactional outbox and queue persistence
- **Stage 3:** Idempotency and configurable workers
- **Stage 4:** Rate limiting and minimum delay
- **Stage 5:** SMTP and Slack integration
- **Stage 6:** Elasticsearch and Google OAuth verification
- **Stage 7:** Preflight and delivery forecast
- **Stage 8:** Sender health monitor
- **Stage 9:** Failure and recovery centre
- **Stage 10:** AI Copilot
- **Stage 11:** Frontend integration
- **Stage 12:** Testing, README, GitHub and video

---

## 2. Non-Negotiable Architectural Mandates

1. **ABSOLUTELY NO CRON JOBS:** No `crontab`, `node-cron`, `agenda`, `setInterval` polling, or cron libraries.
2. **BullMQ / Persistent DB & Redis Scheduling:** Exact scheduling without polling loops (`delayMs = Math.max(0, scheduledAt.getTime() - Date.now())`).
3. **PostgreSQL as Permanent Source of Truth:** All persistent state (users, campaigns, recipients, deliveries, attempts, outbox, senders, OAuth tokens) lives in PostgreSQL.
4. **Crash & Restart Durability:** Future scheduled jobs must survive restarts. Redis persists queued and delayed jobs.
5. **No Blind Resending:** Emails already sent must never be blindly resent or re-dispatched.
6. **Per-Delivery Idempotency:** Every recipient delivery must be guarded by a PostgreSQL unique constraint and deterministic keys.
7. **Real SMTP Delivery:** Never fake SMTP success. No synthetic message IDs or simulated preview URLs on delivery failure; real errors must propagate for exponential retry and failure tracking.
8. **Shared Sender-Level Rate Limiting:** Enforce shared hourly rate limits per SMTP sender across multiple campaigns in addition to campaign-level rate limits.
9. **Configurable Worker Concurrency:** Concurrency must be environment-driven via `WORKER_CONCURRENCY` (defaulting safely to 2).
10. **Configurable Inter-Email Spacing:** Minimum inter-send delay must be configurable via `EMAIL_SEND_DELAY_MS` (default 2000ms).
11. **Preserve Existing Functionality & Production Data:** Never delete existing working features, and never reset or drop existing data.
12. **No Frontend Modifications During Phase 1:** Keep changes focused on the backend and database architecture.
13. **No Secrets in Source:** Never commit secrets, tokens, or `.env` files.

---

## 3. Stage 1 Scope: Database Migrations and Delivery Model

Stage 1 builds the durable PostgreSQL foundation that supports individual email delivery tracking, historical data preservation, and future distributed worker processing:

### 3.1 Migration Version Tracking (`backend/src/db/migrate.ts`)
- `schema_migrations` table with filename, SHA-256 checksum, and applied timestamp.
- PostgreSQL advisory locking (`pg_advisory_lock(7142981)`) to serialize concurrent migration runners.
- Safe bootstrap detection:
  - Fresh database: run all migrations sequentially in transactions.
  - Complete legacy schema (001, 002, 003 installed): verify schema integrity, record baseline migrations in `schema_migrations` with their checksums without re-running.
  - Partial/inconsistent schema: halt immediately with detailed diagnostics.
- Checksum verification: detect and reject modified previously applied migration files.
- Transactional execution: each migration executed inside `BEGIN ... COMMIT` with automatic rollback on error.

### 3.2 Durable Delivery Model (`email_deliveries`)
- Distinct delivery records with:
  - `id`: UUID PRIMARY KEY
  - `campaign_id`: UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE
  - `recipient_id`: UUID NOT NULL REFERENCES recipients(id) ON DELETE CASCADE
  - `sender_id`: UUID REFERENCES senders(id) ON DELETE SET NULL
  - `idempotency_key`: VARCHAR NOT NULL UNIQUE
  - `status`: VARCHAR NOT NULL (CHECK constraint: `pending`, `scheduled`, `sending`, `retry_wait`, `sent`, `failed`, `unknown`, `cancelled`)
  - `scheduled_at`, `sent_at`, `smtp_message_id`, `attempt_count`, `last_error`, `next_attempt_at`
  - `claim_owner`, `claimed_at`, `lease_expires_at` (for future distributed worker locking in Stage 3)
  - `created_at`, `updated_at`
- Unique constraint on `(campaign_id, recipient_id)`.

### 3.3 Attempt History (`email_attempts`)
- Complete audit trail of every SMTP dispatch attempt:
  - `id`: UUID PRIMARY KEY
  - `delivery_id`: UUID NOT NULL REFERENCES email_deliveries(id) ON DELETE CASCADE
  - `attempt_number`: INTEGER NOT NULL
  - `status`: VARCHAR NOT NULL (CHECK constraint: `attempting`, `sent`, `failed`, `unknown`, `rate_limited`)
  - `smtp_response_code`, `smtp_message_id`, `error_classification`, `error_message`
  - `attempted_at`, `completed_at`
- Unique constraint on `(delivery_id, attempt_number)`.

### 3.4 Transactional Outbox Schema (`delivery_outbox`)
- Reliable event publishing table:
  - `id`: UUID PRIMARY KEY
  - `event_type`: VARCHAR NOT NULL
  - `aggregate_id`: UUID NOT NULL
  - `deduplication_key`: VARCHAR NOT NULL UNIQUE
  - `payload`: JSONB NOT NULL
  - `status`: VARCHAR NOT NULL (CHECK constraint: `pending`, `processing`, `dispatched`, `failed`)
  - `attempt_count`: INTEGER NOT NULL DEFAULT 0
  - `available_at`, `dispatched_at`, `last_error`, `created_at`
- Unique constraint `uq_delivery_outbox_dedup (deduplication_key)`.

### 3.5 Historical Backfill Migration (`005_backfill_historical_deliveries.sql` / `007`)
- Safe, non-destructive migration that:
  - Populates `email_deliveries` from existing `recipients`, `campaigns`, and `email_logs`.
  - Maps existing states accurately: sent -> `sent`, failed -> `failed`, scheduled -> `scheduled`, draft -> `pending`, completed/terminated -> `cancelled`.
  - Populates `email_attempts` from historical `email_logs`.
  - Uses `ON CONFLICT DO NOTHING`.
  - Zero historical campaigns restarted or resent.

### 3.6 Cryptographic Security (`backend/src/utils/crypto.ts`)
- Authenticated AES-256-GCM encryption with 96-bit random IV and 128-bit authentication tag.
- Idempotent: does not double-encrypt already-encrypted data.
- Transparent backward compatibility: handles legacy unencrypted passwords safely.
- Fail-closed in production: missing or weak `ENCRYPTION_KEY` halts startup.

### 3.7 Database Type Consistency
- Synchronized `db.types.ts` with all delivery, attempt, and outbox tables and status constraints.
- Aligned `CampaignStatus` to include `'completed'`.
