# IMPLEMENTATION LOG — ReachInbox Email Delivery Platform

---

## Entry 001: Phase 0 Audit

| Field | Value |
|-------|-------|
| **Date** | 2026-11-17T11:13:26+05:30 |
| **Phase** | Phase 0 — Comprehensive Codebase Audit |
| **Branch** | `main` |
| **Base Commit** | `526849ed7ba7c61773509acea4dfb6324aee732a` |
| **Remote URL** | `https://github.com/manojsekar164-crypto/Reachinbox-email-scheduler-.git` |
| **Performed By** | AI Architect (Antigravity) |

### Commands Executed

| # | Command | Directory | Exit Code | Notes |
|---|---------|-----------|-----------|-------|
| 1 | `npm install` | `backend/` | 0 | 244 packages installed. 6 vulnerabilities (1 moderate, 4 high, 1 critical). |
| 2 | `npm install` | `frontend/` | 0 | 60 packages installed. 2 high vulnerabilities. |
| 3 | `npx tsc --noEmit` | `backend/` | 0 | ✅ Zero TypeScript errors. Clean type check. |
| 4 | `npx tsc` | `backend/` | 0 | ✅ Clean build to `dist/`. |
| 5 | `npx tsc -b --noEmit` | `frontend/` | 0 | ✅ Zero TypeScript errors. |
| 6 | `npm audit` | `backend/` | 1 | 6 vulnerabilities reported. All fixable via `npm audit fix`. |
| 7 | `npm audit` | `frontend/` | 1 | 2 high vulnerabilities reported. |
| 8 | `Select-String cron\|node-cron\|agenda\|crontab` | `backend/src/` | 0 | ✅ CONFIRMED: Zero cron library usage. Only comments stating cron is NOT used. |

### Actual Test Results

| Test | Result | Notes |
|------|--------|-------|
| Backend TypeScript compilation | ✅ PASS | Zero errors |
| Frontend TypeScript compilation | ✅ PASS | Zero errors |
| Backend build (`tsc`) | ✅ PASS | Outputs to `dist/` |
| Cron library search | ✅ PASS | No cron libraries found |
| `npm test` | ❌ N/A | No `test` script defined in `package.json` |
| Integration test scripts | ⏭️ SKIPPED | Require live PostgreSQL, Redis, Elasticsearch (Docker containers not running) |

### Outstanding Issues

**18 findings documented in [PHASE_0_AUDIT.md](./PHASE_0_AUDIT.md):**

| Severity | Count | Key Issues |
|----------|-------|------------|
| 🔴 CRITICAL | 4 | F01 (no DB idempotency constraint), F02 (fake SMTP fallback), F03 (plaintext SMTP credentials), F04 (missing ENCRYPTION_KEY) |
| 🟠 HIGH | 7 | F05 (no sender-level rate limiting), F06 (no restart recovery), F07 (no deterministic job IDs), F08 (removeOnComplete:true), F09 (CampaignStatus mismatch), F10 (no migration versioning), F11 (auth bypass risk), F17 (Redis AOF) |
| 🟡 MEDIUM | 5 | F12 (hardcoded concurrency), F13 (PATCH/DELETE don't sync BullMQ), F14 (no test framework), F15 (Slack mock in prod), F16 (config port mismatch) |
| 🔵 LOW | 2 | F18 (git reconciliation completed), npm vulnerabilities |

### Files Read During Audit

**Backend (43 files):**
- `package.json`, `tsconfig.json`, `docker-compose.yml`, `.env.example`, `README.md`
- `src/app.ts`, `src/server.ts`
- `src/config/index.ts`
- `src/auth/passport.ts`
- `src/db/postgres.ts`, `src/db/redis.ts`, `src/db/migrate.ts`
- `src/db/migrations/001_initial_schema.sql`, `002_add_senders.sql`, `003_add_slack_integrations.sql`
- `src/types/db.types.ts`, `src/types/express.d.ts`, `src/types/index.ts`
- `src/utils/crypto.ts`
- `src/middleware/errorHandler.ts`, `src/middleware/requestLogger.ts`, `src/middleware/requireAuth.ts`
- `src/queue/emailQueue.ts`
- `src/workers/emailWorker.ts`
- All 13 service files
- All 6 controllers
- All 7 route files
- All 17 script files

**Frontend (10 files):**
- `package.json`, `vite.config.ts`, `.env.example`
- `src/App.tsx`, `src/main.tsx`, `src/api/client.ts`, `src/services/api.ts`, `src/types/index.ts`, `src/context/AuthContext.tsx`

**Root (2 files):**
- `README.md`, `.gitignore`

---

## Entry 002: Establishing Official GitHub Source of Truth

| Field | Value |
|-------|-------|
| **Date** | 2026-11-17T11:35:00+05:30 |
| **Phase** | Phase 0 Baseline Establishment |
| **Branch** | `main` |
| **Remote Repository** | `https://github.com/manojsekar164-crypto/Reachinbox-email-scheduler-.git` |
| **Head Commit on Remote** | `526849ed7ba7c61773509acea4dfb6324aee732a` |
| **Commit Message** | `feat(slack): send live Slack notifications on campaign launch, rate limits, and delivery completion` |
| **Performed By** | AI Architect (Antigravity) |

### Reconciliation Actions
1. Cloned remote repository to inspect genuine commit history (18 verified commits).
2. Connected local workspace to `origin/main` preserving entire genuine history without modification or history rewriting.
3. Verified local files matched remote commit `526849e` (with line endings restored cleanly via index).
4. Checked for exposed credentials, secret keys, or `.env` files — verified only `.env.example` files are tracked.
5. Created canonical documentation:
   - `docs/PHASE_0_AUDIT.md` (detailed audit report with 18 findings)
   - `docs/ANTIGRAVITY_PROMPTS.md` (prompts and instructions log)
   - `docs/IMPLEMENTATION_LOG.md` (milestone and test tracking log)
6. Phase 0 milestone recorded as accepted and completed.

---

## Entry 003: Stage 1 — Database Migrations and Durable Delivery Model

| Field | Value |
|-------|-------|
| **Date** | 2026-11-17T12:20:00+05:30 |
| **Phase / Stage** | Stage 1: Database Migrations and Durable Delivery Model |
| **Branch** | `feat/database-foundation` |
| **Base Commit** | `47c7ada639d57349eeb7cbba34db6309c324c9ed` |
| **Remote URL** | `https://github.com/manojsekar164-crypto/Reachinbox-email-scheduler-.git` |
| **Performed By** | AI Architect (Antigravity) |

### Changes Implemented

1. **Migration Version Tracking & Advisory Lock Serialization (`src/db/migrate.ts`):**
   - Implemented `schema_migrations` tracking table with SHA-256 checksum verification (`VARCHAR(64)`).
   - Acquired session-level advisory lock (`pg_advisory_lock(7142981)`) with guaranteed release in `finally` block to serialize migrations.
   - Safe bootstrap strategy: detects fresh DB vs complete legacy schema (tables `users`, `campaigns`, `recipients`, `email_logs`, `senders`, `slack_integrations`) vs partial schema (fails closed on partial).
   - Tamper detection: throws immediately if applied migration file checksum differs from stored checksum.
   - Transactional per-migration execution (`BEGIN ... COMMIT / ROLLBACK`).

2. **Database-Level Idempotency & Sender Limits (`004_add_idempotency_and_sender_limit.sql`):**
   - Added partial unique index `idx_email_logs_idempotency` on `email_logs (campaign_id, recipient_id) WHERE status = 'sent'`.
   - Added `hourly_limit INTEGER NOT NULL DEFAULT 100` column to `senders` table.

3. **Durable Delivery & Outbox Schema (`006_create_delivery_and_outbox_schema.sql`):**
   - `email_deliveries` table: canonical delivery state machine (`pending`, `scheduled`, `sending`, `retry_wait`, `sent`, `failed`, `unknown`, `cancelled`).
   - Unique constraints: `uq_email_deliveries_campaign_recipient (campaign_id, recipient_id)` and `uq_email_deliveries_idempotency_key (idempotency_key)`.
   - `email_attempts` table: immutable dispatch audit log (`attempting`, `sent`, `failed`, `unknown`, `rate_limited`).
   - `delivery_outbox` table: transactional outbox for atomic database & queue persistence (`pending`, `processing`, `dispatched`, `failed`) with deduplication constraint `uq_delivery_outbox_dedup (deduplication_key)`.

4. **Historical Data Backfill (`007_backfill_historical_deliveries.sql`):**
   - Backfilled existing `recipients` and `campaigns` into `email_deliveries` using `ON CONFLICT DO NOTHING`.
   - Accurate historical state mapping: sent -> `sent`, failed -> `failed`, scheduled -> `scheduled`, draft -> `pending`, completed/terminated without log -> `cancelled`.
   - Backfilled historical `email_logs` into `email_attempts`.
   - Zero historical campaign restarts or duplicate sends.

5. **At-Rest Authenticated Credential Encryption (`src/utils/crypto.ts` & `src/services/senderService.ts`):**
   - Implemented `safeEncrypt` and `safeDecrypt` using authenticated AES-256-GCM.
   - Output format: `<iv_hex_24>:<auth_tag_hex_32>:<cipher_hex>` (with support for versioned `enc:v1:` prefix).
   - Key derivation: `getDerivedEncryptionKey()` fails closed in production if `ENCRYPTION_KEY` is missing or invalid.
   - Encrypted `smtp_pass` before persisting in PostgreSQL; transparently decrypted on retrieval for authorized background worker operations.
   - Added legacy plaintext backward-compatibility guard preventing double encryption or decryption crashes.
   - One-time credential migration command: `npm run credentials:migrate`.

6. **Eliminated Fake SMTP Tier 3 Fallback (`src/services/emailService.ts`):**
   - Completely removed synthetic message ID (`<hex@reachinbox.email>`) and simulated Ethereal preview URL generation.
   - Real delivery failures now propagate genuinely to BullMQ for exponential backoff retries.

7. **Shared Sender-Level Rate Limiting (`src/services/rateLimiter.ts` & `src/workers/emailWorker.ts`):**
   - Implemented `checkSenderRateLimit(senderId, limit, windowSeconds)` using atomic Redis Lua scripts (`rate-limit:sender:${senderId}`).
   - Worker checks shared sender rate limits in addition to campaign rate limits, delaying jobs via BullMQ `moveToDelayed` without burning attempts.

8. **Configurable Worker Concurrency & Defaults (`src/config/index.ts`, `src/workers/emailWorker.ts`, `.env.example`):**
   - Added `WORKER_CONCURRENCY` environment parsing defaulting to 2.
   - Worker concurrency now dynamically pulls from configuration.
   - Documented `ENCRYPTION_KEY` and `WORKER_CONCURRENCY` in `backend/.env.example`.

9. **Idempotent Worker Post-Send Persistence (`src/workers/emailWorker.ts`):**
   - Updated success insert in `email_logs` to use `ON CONFLICT (campaign_id, recipient_id) WHERE status = 'sent' DO NOTHING RETURNING id`.

10. **Queue Retention & Job ID Hardening (`src/queue/emailQueue.ts`, `src/services/schedulingService.ts`):**
    - Hardened `removeOnComplete` to `{ count: 1000, age: 86400 }` to maintain historical audit logs on Bull Board.
    - Added deterministic BullMQ job IDs (`campaign_${campaignId}_${recipientId}`) in `schedulingService.ts`.

11. **Type Harmonization (`src/types/db.types.ts`, `src/controllers/campaignController.ts`):**
    - Added `DeliveryStatus`, `EmailDeliveryRow`, `EmailAttemptStatus`, `EmailAttemptRow`, `OutboxStatus`, `DeliveryOutboxRow`, `SchemaMigrationRow`.
    - Aligned `CampaignStatus` to include `'completed'`, `'sent'`, `'sending'`, `'scheduled'`, `'draft'`, `'failed'`.
    - Added `hourly_limit` to `SenderRow` interface.

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Phase 1 Verification Suite | `npm run phase1:test` | ✅ PASS | 16/16 assertions passed (encryption roundtrip, format, double-encrypt guard, legacy fallback, concurrency config, migration syntax) |
| Stage 1 Invariant Suite | `npm run stage1:test` | ✅ PASS | 40/40 assertions passed (checksums, advisory lock, tampering detection, AES-256-GCM round-trip, semantic IV security, fail-closed production key, SQL constraint checks, TypeScript type alignment) |
| Backend TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero compilation errors; compiled cleanly to `dist/` |
| Frontend Type Check | `npx tsc -b --noEmit` | ✅ PASS | Zero errors; frontend completely untouched |
| Live PostgreSQL Integration | `npm run stage1:test` (Group 6) | ⚠️ BLOCKED | PostgreSQL offline at `localhost:5432` (`ECONNREFUSED`). Reported as BLOCKED without falsifying results. |
| Live Migration Execution | `npm run db:migrate` | ⚠️ BLOCKED | Fails cleanly with connection refused message when DB offline; ready to run once DB is up. |

### Status
Stage 1 implementation complete and verified on branch `feat/database-foundation`. Awaiting user review before any Stage 2 activity.

---

## Entry 004: Phase 1 Migration Safety Hardening & Real PostgreSQL Verification (Rounds 1–3)

| Field | Value |
|-------|-------|
| **Date** | 2026-11-17T15:35:00+05:30 |
| **Phase / Stage** | Phase 1: Database Foundation & Delivery Reliability (Safety Reviews 1, 2, 3) |
| **Branch** | `feat/database-foundation` |
| **Base Commit** | `6bcdc88` |
| **Remote URL** | `https://github.com/manojsekar164-crypto/Reachinbox-email-scheduler-.git` |
| **Performed By** | AI Senior Backend & PostgreSQL Architect (Antigravity) |

### Engineering Review Directives Implemented

1. **Historical Duplicate Safety (Migration 004):**
   - Discovered genuine historical duplicate sent logs in production backup (`campaign_id = 69d12cf2-9201-4b82-92f6-7c2ed26968ee, recipient_id = 58e14b04-cf6c-4935-8dc7-50081ba6f50c`).
   - Removed unsafe `CREATE UNIQUE INDEX` from `004_add_idempotency_and_sender_limit.sql`.
   - Replaced with non-unique B-tree lookup index `idx_email_logs_campaign_recipient`.
   - Canonical idempotency enforced exclusively on `email_deliveries (campaign_id, recipient_id)` in Migration 006.

2. **Relational Integrity & Historical Data Protection (Migration 006):**
   - Replaced all `ON DELETE CASCADE` clauses on `email_deliveries` and `email_attempts` with `ON DELETE RESTRICT`.
   - Added composite unique index `uq_recipients_id_campaign` on `recipients (id, campaign_id)`.
   - Added composite foreign key constraint `fk_email_deliveries_recipient_campaign` on `email_deliveries (recipient_id, campaign_id) REFERENCES recipients (id, campaign_id) ON DELETE RESTRICT`.
   - Added `deleted_at TIMESTAMPTZ` for safe soft-delete support.
   - Added non-negative check constraints on counters (`attempt_count >= 0`).

3. **Multi-Worker Outbox Leasing & Deduplication (Migration 006):**
   - Added `claim_owner VARCHAR`, `claimed_at TIMESTAMPTZ`, and `lease_expires_at TIMESTAMPTZ` to `delivery_outbox`.
   - Added unique constraint `uq_delivery_outbox_dedup (deduplication_key)` preventing duplicate queue publishing.

4. **Fail-Closed Historical Status Mapping & Backfill (Migration 007):**
   - Completely removed unsafe `ELSE 'pending'`.
   - Mapped ambiguous historical logs (`status NOT IN ('sent', 'failed')`) to non-dispatchable `'unknown'`.
   - Mapped pre-upgrade active campaigns (`sending`, `paused`) and expired scheduled campaigns to non-dispatchable `'cancelled'`.
   - Mapped draft campaigns to `'pending'`.
   - Deterministic tie-breaking on `ORDER BY el.created_at ASC, el.id ASC`.
   - Cleared stale `last_error` when delivery was confirmed sent.
   - Preserved `sender_id` and `error_message` while leaving unavailable SMTP metadata (`smtp_message_id`, `smtp_response_code`, `error_classification`) strictly as `NULL`.

5. **Draft Campaign Dispatch Safety Verification:**
   - Worker claim queries strictly enforce `JOIN campaigns c ON c.id = ed.campaign_id WHERE ed.status = 'pending' AND c.status = 'sending'`.
   - Proved in real PostgreSQL that draft deliveries (`c.status = 'draft'`) return 0 rows to worker queries.
   - Proved zero outbox events are created for draft campaigns during migration.

6. **Migration Runner Tamper Detection (`migrate.ts`):**
   - Rejects empty/missing checksums with explicit invariant errors.
   - Verifies applied migration SHA-256 hashes against disk files.
   - Serializes runner via session advisory lock `7142981`.

7. **Isolated Ephemeral Integration Test Suite (`testIsolatedMigration.ts`):**
   - Creates ephemeral database `reachinbox_migration_test`.
   - Restores verified backup `backups/reachinbox-pre-stage1.dump`.
   - Seeds edge cases (draft campaigns, ambiguous in-flight logs, expired scheduled, sent+failed).
   - Executes migrations 001–007.
   - Validates all 31 Round 3 invariants.
   - Cleans up and verifies production database `reachinbox` remained 100% untouched.

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Isolated PostgreSQL Live Suite | `npm run isolated-db:test` | ✅ PASS | 31/31 assertions passed on real ephemeral PostgreSQL 16.15 instance with production backup restore |
| Stage 1 Verification Suite | `npm run stage1:test` | ✅ PASS | 49/49 assertions passed (checksums, AES-256-GCM authenticated encryption, advisory lock, check constraints, schema invariants) |
| Phase 1 Database Test | `npm run phase1:test` | ✅ PASS | 16/16 assertions passed (migration 004 non-unique index, duplicate safety, worker concurrency) |
| Backend TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero compilation errors; compiled cleanly to `dist/` |
| Frontend Type Check | `npx tsc -b --noEmit` | ✅ PASS | Zero errors; frontend completely untouched |
| Production Database Integrity | Direct SQL query | ✅ PASS | `reachinbox` database 100% untouched; exactly 6 baseline tables |

### Status
Phase 1 Migration Correction & Safety Review (Round 3) complete.
Zero migrations executed on production database.
Zero git commits or pushes made.
Awaiting explicit operator authorization.

---

## Entry 005: Batch 1 – Atomic Delivery Claiming and Worker Idempotency

| Field | Value |
|-------|-------|
| **Date** | 2026-11-17T16:15:00+05:30 |
| **Batch** | Batch 1: Atomic Delivery Claiming & Worker Idempotency |
| **Branch** | `feat/database-foundation` |
| **Base Commit** | `6bcdc88` |
| **Remote URL** | `https://github.com/manojsekar164-crypto/Reachinbox-email-scheduler-.git` |
| **Performed By** | AI Senior Backend & PostgreSQL Architect (Antigravity) |

### Engineering Fixes Implemented

1. **Atomic Delivery Claiming (`src/services/deliveryService.ts`):**
   - Implemented `claimDelivery()` using PostgreSQL `FOR UPDATE OF ed SKIP LOCKED` with atomic `UPDATE email_deliveries ... RETURNING ed.*`.
   - Transitions delivery status atomically to `'sending'`.
   - Records `claim_owner`, `claimed_at`, and `lease_expires_at` (default 60 seconds lease).
   - Verifies campaign eligibility: requires `campaigns.status = 'sending'`.
   - Strictly excludes soft-deleted deliveries (`deleted_at IS NULL`).
   - Ensures concurrent workers racing for the exact same delivery never double-claim: exactly one worker acquires the row, the concurrent worker receives `NULL` and skips without blocking.

2. **Worker Idempotency & Attempt Tracking (`src/workers/emailWorker.ts`):**
   - Uses `email_deliveries` as the canonical delivery state machine.
   - Pre-flight check: if delivery `status = 'sent'`, skips immediately without sending.
   - Audit trail: records each dispatch attempt in `email_attempts` (`attempt_number`, `status`, `sender_id`, `attempted_at`, `completed_at`, `smtp_message_id`).
   - Duplicate BullMQ job safety: subsequent duplicate jobs detect `delivery.status === 'sent'` and complete idempotently without duplicate sends or additional attempts.
   - Backward compatibility: preserves historical `email_logs` recording on delivery success and failure.

3. **Uncertain Delivery Outcome Safety:**
   - Detects in-doubt SMTP errors (`isUncertainSmtpError()`: socket resets, timeouts during DATA transmission, explicit uncertain flags).
   - Marks delivery and attempt as `'unknown'`.
   - Does NOT rethrow to BullMQ, preventing automated duplicate retry loops.
   - Subsequent retry attempts explicitly refuse to blindly send deliveries in `'unknown'` status.

4. **Integration Test Suite (`src/scripts/testBatch1DeliveryClaiming.ts`):**
   - Tests all 5 verification scenarios against ephemeral database `reachinbox_migration_test`:
     1. Two workers claiming the same delivery concurrently (`FOR UPDATE SKIP LOCKED`).
     2. Processing an already-sent delivery (idempotency, zero sends).
     3. Reprocessing a duplicate BullMQ job (zero duplicate attempts).
     4. An uncertain delivery outcome (mapped to `'unknown'`, never automatically retried).
     5. Soft-delete and draft campaign eligibility safety.

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Batch 1 Verification Suite | `npm run batch1:test` | ✅ PASS | 24/24 assertions passed (concurrency, idempotency, duplicate jobs, uncertain outcome, soft delete) |
| Isolated DB Migration Suite | `npm run isolated-db:test` | ✅ PASS | 31/31 assertions passed on real ephemeral PostgreSQL |
| Stage 1 Invariant Suite | `npm run stage1:test` | ✅ PASS | 49/49 assertions passed |
| Phase 1 Database Test | `npm run phase1:test` | ✅ PASS | 16/16 assertions passed |
| TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero errors, clean compilation |
| Production DB Integrity | Direct SQL inspection | ✅ PASS | `reachinbox` database 100% untouched (6 baseline tables) |

---

## [Entry 006] - 2026-11-17 - Phase 1 Batch 2: Transactional Outbox and Queue Persistence

**Scope:** Batch 2 – Transactional Outbox and Queue Persistence
**Branch:** `feat/database-foundation`
**Engineer:** Senior Backend Engineer

### Implementation Summary

1. **Transactional Campaign Creation (`src/services/campaignService.ts`):**
   - Refactored `createCampaignWithRecipients()` to execute entirely within a single atomic PostgreSQL transaction (`BEGIN ... COMMIT / ROLLBACK`).
   - Inserts `campaigns`, `recipients`, `email_deliveries`, and `delivery_outbox` within the exact same transaction block.
   - Eliminates the database-commit-to-BullMQ-publish failure gap: if any operation fails, all records roll back completely with zero orphaned partial state.
   - Outbox event payload encodes delivery ID, campaign ID, recipient ID, and scheduled timestamp.
   - Immediate asynchronous sweep triggers publisher processing without waiting for polling loops.

2. **Reliable Outbox Publisher (`src/services/outboxPublisher.ts`):**
   - Dedicated outbox publisher using PostgreSQL `FOR UPDATE SKIP LOCKED` and `UPDATE ... RETURNING`.
   - Records publisher claim ownership (`claim_owner`) and lease expiry (`lease_expires_at`).
   - Leases expire automatically after a configurable duration (default 30 seconds), enabling crash recovery.
   - Publishes jobs to BullMQ queue using delivery IDs and deterministic deduplication keys (`campaign_<campaignId>_<recipientId>`).
   - Marks outbox records as `dispatched` with timestamp only AFTER successful BullMQ job creation (`markOutboxDispatched`).
   - Marks outbox records as `failed` if an error occurs during publication, incrementing attempt counts.
   - Re-entrancy and sweep idempotency: already dispatched events are completely ignored on repeated sweeps or publisher restarts.

3. **Future Scheduled Deliveries & Queue Persistence:**
   - Preserves exact PostgreSQL `scheduled_at` timestamp.
   - Publishes future scheduled deliveries to BullMQ with `delay = Math.max(0, scheduledAt.getTime() - Date.now())`.
   - Worker checks scheduled timestamp: if `scheduled_at > NOW()`, refuses early execution and skips cleanly.
   - At due time (`scheduled_at <= NOW()`), atomically activates campaign from `scheduled` to `sending` via `activateDueCampaign()` and claims delivery via `claimDelivery()`.
   - Outbox recovery reconciliation (`recoverFutureScheduledDeliveries()`): scans for future scheduled deliveries missing outbox records and recovers them into the outbox.
   - Safety guard: NEVER creates recovery records for `sent`, `cancelled`, `unknown`, `failed`, or `draft` deliveries.

4. **Integration Test Suite (`src/scripts/testBatch2OutboxAndQueuePersistence.ts`):**
   - Implemented real integration tests covering all 9 required verification scenarios against ephemeral PostgreSQL DB `reachinbox_migration_test`:
     1. Transaction failure atomicity (recipient, delivery, or outbox failure triggers total rollback).
     2. Concurrent publishers claiming outbox records (`FOR UPDATE SKIP LOCKED` yields disjoint sets with zero overlap).
     3. Expired publisher lease recovery (expired lease claimed by new publisher, claim owner reassigned).
     4. Publisher crash after `queue.add` but before outbox update (authoritative PostgreSQL state prevents duplicate delivery).
     5. Repeated publication after restart (sweep idempotency, zero duplicate jobs).
     6. Completed BullMQ job removal (`removeOnComplete: true`) followed by recovery (database state prevents duplicate send).
     7. Future scheduled delivery publishing (exact delay preserved, worker refuses early execution, succeeds at due time).
     8. Reconcile future scheduled deliveries without outbox records (legitimate future deliveries safely recovered).
     9. Sent, cancelled, unknown, failed, or draft deliveries are NEVER replayed (zero recovery outbox records).

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Batch 2 Verification Suite | `npm run batch2:test` | ✅ PASS | 25/25 assertions passed across all 9 scenarios |
| Batch 1 Verification Suite | `npm run batch1:test` | ✅ PASS | 24/24 assertions passed (concurrency, idempotency, duplicate jobs, uncertain outcome, soft delete) |
| Isolated DB Migration Suite | `npm run isolated-db:test` | ✅ PASS | 31/31 assertions passed on real ephemeral PostgreSQL |
| Stage 1 Invariant Suite | `npm run stage1:test` | ✅ PASS | 49/49 assertions passed |
| Phase 1 Database Test | `npm run phase1:test` | ✅ PASS | 16/16 assertions passed |
| TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero errors, clean compilation |
| Production DB Integrity | Direct SQL inspection | ✅ PASS | `reachinbox` database 100% untouched (6 baseline tables) |

---

## [Entry 007] - 2026-11-17 - Phase 1 Batch 3: SMTP Reliability and Sender Identity

**Scope:** Batch 3 – SMTP Reliability and Sender Identity
**Branch:** `feat/database-foundation`
**Starting Baseline Commit:** `8f121d2fcb0a468249dcd50d3712bbbbcb8a7301`
**Engineer:** Senior Backend Engineer

### Implementation Summary

1. **Enforce SMTP Sender Identity (`src/services/emailService.ts`):**
   - **Zero Fallback Invariant:** Completely eliminated automatic fallback to the default global Ethereal account when a campaign's explicitly configured sender credentials fail.
   - **Sender Identity Preservation:** When `sender` is provided, `sendEmail` strictly dispatches using the sender's own credentials. If connection or authentication fails, the original error is propagated immediately with full forensic context without altering sender identity.
   - **Permitted Default Sender:** Default SMTP credentials are utilized only when `campaign.sender_id` is null (`sender` parameter is omitted) and application policy permits it.
   - **Cached Transporters with Session Tracking:** Implemented `createTrackedTransporter` wrapping Nodemailer transports with scoped session telemetry. Transporters are cached by cryptographic SHA-256 hash of sender credentials (`smtp_host:smtp_port:smtp_secure:smtp_user:smtp_pass`), invalidating and closing connections cleanly when credentials change.
   - **Multi-Sender Integrity:** Tested and verified that distinct senders run concurrently with separate authenticated sessions and respective `From` headers.

2. **Conservative SMTP Error Classification (`src/services/smtpClassifier.ts`):**
   - Created dedicated `classifySmtpOutcome(error, context)` module categorizing outcomes into 5 strict categories:
     1. `confirmed_acceptance`: Confirmed SMTP 2xx acknowledgment (terminal `sent`).
     2. `permanent_rejection`: Definitive 5xx rejection or authentication failure (non-retryable terminal `failed`).
     3. `transient_rejection`: Definitive 4xx temporary rejection (safe to retry, status `retry_wait`, BullMQ backoff retry scheduled).
     4. `connection_failure`: Network or TCP socket failure confirmed before message DATA transmission (safe to retry, status `retry_wait`).
     5. `ambiguous_outcome`: Connection drop, reset, or timeout during or after message DATA transmission (in-doubt terminal `unknown`, NEVER retried).
   - Invariant: Only retries failures confirmed to have occurred before message acceptance. Any severed connection or timeout occurring during/after the DATA phase is treated as ambiguous (`unknown`) and never blindly retried.
   - Extracts 3-digit SMTP status codes (e.g., `535`, `550`, `451`, `250`) and enhanced status codes (e.g., `5.7.8`, `5.1.1`, `4.3.0`, `2.0.0`).

3. **Worker & Delivery Service Integration (`src/workers/emailWorker.ts`, `src/services/deliveryService.ts`):**
   - Integrated `classifySmtpOutcome` into `emailWorker.ts`:
     - On `confirmed_acceptance`: Extracts genuine SMTP server message ID (e.g., from `queued as <...>`) and records `sent` status in `email_deliveries` and `email_attempts` with response code `250`.
     - On `ambiguous_outcome`: Calls `recordAttemptAmbiguousOutcome`, logs explicit warning, marks delivery and attempt as `unknown`, records in historical `email_logs`, and completes job cleanly without rethrowing (preventing BullMQ retry loops).
     - On `permanent_rejection`: Calls `recordAttemptPermanentRejection`, marks delivery and attempt as `failed`, records in `email_logs`, and completes cleanly without rethrowing.
     - On `transient_rejection` / `connection_failure`: Calls `recordAttemptTransientRejection` / `recordAttemptConnectionFailure`, sets delivery status to `retry_wait`, calculates exponential backoff delay, and rethrows error to allow BullMQ to handle retry scheduling.
   - Added dedicated recording functions in `deliveryService.ts`: `recordAttemptPermanentRejection`, `recordAttemptTransientRejection`, `recordAttemptConnectionFailure`, `recordAttemptAmbiguousOutcome`.

4. **Integration Test Suite (`src/scripts/testBatch3SmtpReliability.ts`):**
   - Implemented an in-process RFC 5321 compliant SMTP server capable of deterministic fault injection across 10 acceptance scenarios:
     1. Selected sender fails authentication: no default sender fallback (status `failed`, zero fallback).
     2. Selected sender fails to connect: no sender switching (status `retry_wait`, zero sender switching).
     3. No sender selected: existing permitted default-sender behaviour remains functional (status `sent`).
     4. SMTP transient rejection before acceptance (4xx): rethrows for retry, delivery status `retry_wait`.
     5. Permanent SMTP rejection (5xx): does not rethrow, delivery terminal `failed`.
     6. Connection failure before DATA transmission: rethrows for retry, delivery status `retry_wait`.
     7. Socket disconnection after DATA transmission while waiting for final acceptance: does not rethrow, delivery terminal `unknown`.
     8. Confirmed SMTP acceptance records actual genuine message ID (not client-side UUID).
     9. Ambiguous SMTP outcome becomes `unknown` and is NEVER automatically retried (subsequent BullMQ worker skips delivery, attempts = 1).
     10. Multiple configured senders retain individual identities (Alpha and Beta dispatches authenticate and deliver separately).

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Batch 3 Verification Suite | `npm run batch3:test` | ✅ PASS | 49/49 assertions passed across all 10 SMTP reliability scenarios |
| Batch 2 Verification Suite | `npm run batch2:test` | ✅ PASS | 25/25 assertions passed across all 9 outbox/persistence scenarios |
| Batch 1 Verification Suite | `npm run batch1:test` | ✅ PASS | 24/24 assertions passed (concurrency, idempotency, duplicate jobs, uncertain outcome, soft delete) |
| Isolated DB Migration Suite | `npm run isolated-db:test` | ✅ PASS | 31/31 assertions passed on real ephemeral PostgreSQL |
| Stage 1 Invariant Suite | `npm run stage1:test` | ✅ PASS | 49/49 assertions passed |
| Phase 1 Database Test | `npm run phase1:test` | ✅ PASS | 16/16 assertions passed |
| TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero errors, clean compilation |
| Production DB Integrity | Direct SQL inspection | ✅ PASS | `reachinbox` database 100% untouched (6 baseline tables) |


---

## [Entry 008] - 2026-11-17 - Phase 1 Batch 3.1: SMTP Persistence Corrections

**Scope:** Batch 3.1 – SMTP Persistence Corrections
**Branch:** `feat/database-foundation`
**Starting Baseline Commit:** `369e52bb51c75d2dbf3ee466159c581f47f10ed1`
**Engineer:** Senior Backend Engineer

### Implementation Summary

1. **Remove Fabricated SMTP Response Metadata (`src/services/smtpClassifier.ts`, `src/services/deliveryService.ts`, `src/workers/emailWorker.ts`):**
   - **Zero Fabrication Invariant:** Removed all hardcoded fallbacks to `'250'` and `'2.0.0'` across the codebase.
   - When no actual server response exists or when response-code metadata is absent, `classifySmtpOutcome` and `emailWorker` record `responseCode: null` and `enhancedStatusCode: null`.
   - Updated `deliveryService.recordAttemptSuccess` default parameter from `'250'` to `null`, ensuring PostgreSQL stores `NULL` in `email_attempts.smtp_response_code`.
   - Confirmed SMTP acceptance is strictly preserved as `error_classification = 'confirmed_acceptance'` and delivery status `'sent'`, keeping acceptance separate from missing diagnostic metadata.
   - Refined response-code parsing regex to RFC 5321 line-start anchors `/(?:^|\n)\s*([245]\d{2})\b/`, preventing arbitrary numbers inside message IDs from being misinterpreted as status codes.

2. **Isolate SMTP Send from Database Persistence (`src/workers/emailWorker.ts`, `src/services/deliveryService.ts`):**
   - **Isolated Error Boundaries:** Refactored `emailWorker.ts` so `sendEmail` operates inside a dedicated, isolated try/catch block. Only actual SMTP and network transport errors reach `classifySmtpOutcome`.
   - **Exclusion of PostgreSQL Errors:** PostgreSQL database errors are never classified as SMTP rejections or connection failures.
   - **No Duplicate Resends After Acceptance:** Once `sendEmail` confirms acceptance, any subsequent database persistence error (e.g., in `recordAttemptSuccess`, `email_logs`, or campaign completion status) enters a dedicated post-acceptance error handler. The job completes cleanly without rethrowing, eliminating BullMQ retry loops that would cause duplicate email dispatches.
   - **Audit Trail & In-Doubt Reconciliation:** Implemented `recordPostgresPersistenceFailure` in `deliveryService.ts`. Transitions `email_deliveries` to terminal non-dispatchable `'unknown'` state with `claim_owner` and `lease_expires_at` cleared. Records `email_attempts` as `'unknown'` with `error_classification = 'persistence_failure_after_acceptance'` while preserving the genuine server message ID.
   - **Resend Prevention:** Verified that worker idempotency checks (`delivery.status === 'unknown'`) and atomic claiming (`claimDelivery`) completely refuse to claim or dispatch deliveries in the `'unknown'` state, guaranteeing recovery processes never blindly resend an accepted delivery.

3. **Acceptance Tests (`src/scripts/testBatch3SmtpReliability.ts`):**
   - **Scenario 8:** Confirmed acceptance with genuine response code (`250`) and genuine message ID.
   - **Scenario 8b:** Confirmed acceptance where response-code metadata is unavailable; verifies status is `'sent'`, genuine message ID is preserved, and `smtp_response_code` is strictly `NULL`.
   - **Scenario 11:** PostgreSQL failure immediately after confirmed SMTP acceptance (`simulateDbFailureAfterSend: true`); verifies worker does not rethrow, delivery and attempt transition to `'unknown'`, and genuine message ID is preserved.
   - **Scenario 12:** Subsequent retry/recovery after database failure; verifies worker skips execution, `claimDelivery` returns `null`, and the SMTP test server receives ZERO duplicate dispatches (count remains 1).
   - **Scenarios 1-10:** All existing sender identity and SMTP classification tests remain 100% passing.

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Batch 3 Verification Suite | `npm run batch3:test` | ✅ PASS | 69/69 assertions passed across all 12 SMTP reliability & persistence scenarios |
| Batch 2 Verification Suite | `npm run batch2:test` | ✅ PASS | 25/25 assertions passed across all 9 outbox/persistence scenarios |
| Batch 1 Verification Suite | `npm run batch1:test` | ✅ PASS | 24/24 assertions passed (concurrency, idempotency, duplicate jobs, uncertain outcome, soft delete) |
| Isolated DB Migration Suite | `npm run isolated-db:test` | ✅ PASS | 31/31 assertions passed on real ephemeral PostgreSQL |
| Stage 1 Invariant Suite | `npm run stage1:test` | ✅ PASS | 49/49 assertions passed |
| Phase 1 Database Test | `npm run phase1:test` | ✅ PASS | 16/16 assertions passed |
| TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero errors, clean compilation |
| Production DB Integrity | Direct SQL inspection | ✅ PASS | `reachinbox` database 100% untouched (6 baseline tables) |


---

## [Entry 009] - 2026-11-17 - Phase 1 Batch 3.2: Stale Claim Safety and SMTP Metadata

**Scope:** Batch 3.2 – Stale Claim Safety and SMTP Metadata
**Branch:** `feat/database-foundation`
**Starting Baseline Commit:** `2cdc32c32cf97b973ec1bba7d3a0eeb9b25a2df6`
**Engineer:** Senior Backend Engineer

### Implementation Summary

1. **Prevent Duplicate Sends After PostgreSQL Outage (`src/services/deliveryService.ts`, `src/workers/emailWorker.ts`):**
   - **Eliminated Expired `sending` Reclaim Invariant:** Removed the clause `OR (ed.status = 'sending' AND ed.lease_expires_at IS NOT NULL AND ed.lease_expires_at < NOW())` from `claimDelivery()`. Stale in-flight deliveries are never automatically reclaimed by standard worker claiming.
   - **Safe Stale Claim Reconciliation (`reconcileStaleDeliveries`):** Implemented dedicated reconciliation using `FOR UPDATE SKIP LOCKED`. Atomically identifies deliveries in `sending` status with expired leases (`lease_expires_at < NOW()`) and transitions them to `unknown` (non-dispatchable, requiring manual review).
   - **Attempt History Reconciliation:** Transitions any lingering `attempting` records for those deliveries to `unknown` with `error_classification = 'stale_claim_reconciliation'`, preserving full audit context.
   - **Lease and Claim Cleanup:** Clears `claim_owner`, `lease_expires_at`, and `next_attempt_at` on reconciled deliveries.
   - **Multi-Worker Concurrency Safety:** Safe across concurrent worker runs and server restarts; live in-flight deliveries with active leases are strictly untouched.

2. **Correct SMTP Response-Code Metadata (`src/services/deliveryService.ts`):**
   - **Numeric SMTP Code Invariant:** Added `extractGenuineSmtpCode()` ensuring `smtp_response_code` stores ONLY authentic 3-digit numeric SMTP response codes (`/^[2345]\d{2}$/`).
   - **Elimination of Non-SMTP Strings:** Completely eliminated storing pseudo-codes such as `'5xx'`, `'4xx'`, and network error codes `'ECONNREFUSED'`, `'ETIMEDOUT'`, or `'ECONNRESET'` in `smtp_response_code`.
   - **Diagnostic Separation:** Network error codes and detailed diagnostic failure contexts are stored strictly in `error_message` and `error_classification`.
   - **NULL When Unavailable:** When an actual SMTP response code is unavailable (e.g. network connection dropped before server response or during handshake), `smtp_response_code` is stored strictly as `NULL`.

3. **Acceptance & Regression Tests (`src/scripts/testBatch3SmtpReliability.ts`):**
   - **Scenario 13:** Stale claim reconciliation after PostgreSQL outage:
     - Simulates SMTP acceptance followed by database persistence failure.
     - Simulates worker crash leaving delivery in `sending` with expired lease and attempt in `attempting`.
     - Executes `reconcileStaleDeliveries()`; verifies delivery becomes `unknown`, not `pending` or `sending`.
     - Verifies claim owner and lease expiry are cleared.
     - Verifies attempt status becomes `unknown` with `stale_claim_reconciliation`.
     - Verifies subsequent worker cannot claim or resend (returns `null`, skips job).
     - Verifies SMTP test server received exactly 1 submission (zero duplicate sends).
   - **Scenario 14:** SMTP response code metadata correctness:
     - Verifies genuine SMTP codes (535, 451, 550, 250) are preserved.
     - Verifies missing response codes remain `NULL` on connection and ambiguous failures.
     - Verifies network error codes (ECONNREFUSED, ETIMEDOUT) are stored in `error_message`, never in `smtp_response_code`.
   - **Full Regression Verification:**
     - Batch 3: 95/95 assertions passed across 14 scenarios.
     - Batch 2: 25/25 assertions passed across 9 scenarios.
     - Batch 1: 24/24 assertions passed across 5 scenarios.
     - TypeScript Build: 0 errors.
     - Production DB `reachinbox`: 100% untouched.

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Batch 3 Verification Suite | `npm run batch3:test` | ✅ PASS | 95/95 assertions passed across all 14 scenarios (including Scenarios 13 and 14) |
| Batch 2 Verification Suite | `npm run batch2:test` | ✅ PASS | 25/25 assertions passed across all 9 outbox/persistence scenarios |
| Batch 1 Verification Suite | `npm run batch1:test` | ✅ PASS | 24/24 assertions passed (concurrency, idempotency, duplicate jobs, uncertain outcome, soft delete) |
| TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero errors, clean compilation |
| Production DB Integrity | Direct SQL inspection | ✅ PASS | `reachinbox` database 100% untouched (6 baseline tables) |
