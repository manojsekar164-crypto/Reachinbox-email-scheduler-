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


---

## [Entry 010] - 2026-11-17 - Phase 1 Batch 3.3: Runtime Stale Delivery Reconciliation

**Scope:** Batch 3.3 – Runtime Stale Delivery Reconciliation
**Branch:** `feat/database-foundation`
**Starting Baseline Commit:** `10763ae245df6f7e443833d7b4cb68010cf354aa`
**Engineer:** Senior Backend Engineer

### Implementation Summary

1. **Worker Runtime Stale Reconciliation Integration (`src/workers/emailWorker.ts`):**
   - **Startup Recovery Invariant:** Implemented `initializeWorker(dbClient)` ensuring `reconcileStaleDeliveries()` strictly executes during worker startup before normal job processing begins. Instantiates BullMQ worker with `autorun: false`, awaits startup reconciliation, and then calls `worker.run()`.
   - **Event-Driven Runtime In-Flight Check:** In `processEmailJob`, added Invariant 3.5: if a delivery is found in `sending` status with an expired lease (`lease_expires_at <= NOW()`), it prioritizes reconciling it to `unknown` immediately, refreshing the delivery state, and skipping execution without resending. Active in-flight deliveries with live leases are skipped cleanly.
   - **Bounded Event-Driven Sweeps (`maybeReconcileStaleDeliveries`):** Wired bounded event-driven reconciliation (at most once every 10 seconds) into `processEmailJob` and BullMQ's `drained` event listener, ensuring stale deliveries from crashes during process lifetime are also eventually reconciled without introducing any cron, fixed polling, or `setInterval` schedulers.
   - **Atomic In-Memory Batch Attempt History Update:** Refactored `reconcileStaleDeliveries` in `deliveryService.ts` to update all corresponding `attempting` records in a single query (`WHERE delivery_id = ANY($1::uuid[]) AND status = 'attempting'`).

2. **Real Database Outage Test (`src/scripts/testBatch3SmtpReliability.ts`):**
   - **Zero Manual SQL Editing:** Completely eliminated simulated manual `UPDATE` queries. The test creates a dedicated client, claims the delivery, records the attempt in `attempting`, and upon confirmed SMTP acceptance, fires `onSmtpAccepted` which terminates the backend PID via `SELECT pg_terminate_backend(pid)` on `adminClient`.
   - **Actual Connection Loss Verification:** Verified worker catches the terminated connection without crashing or rethrowing.
   - **Post-Outage Authoritative State:** Verified that before reconciliation, PostgreSQL naturally held delivery in `sending` and attempt in `attempting` solely due to the terminated connection.
   - **Restored Connectivity & Reconciliation:** Restored database connectivity via a fresh client, waited for the 1.2s lease to expire, and ran `reconcileStaleDeliveries()`.
   - **Verified Reconciliation Outcomes:**
     - Delivery transitioned to `unknown` with claim owner and lease expiry cleared.
     - Attempt history transitioned to `unknown` with classification `stale_claim_reconciliation`.
     - Subsequent BullMQ worker execution skipped without resending.
     - Second worker could not claim the delivery (`claimDelivery` returned `null`).
     - SMTP test server received strictly one submission in total (zero duplicate dispatches).

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Batch 3 Verification Suite | `npm run batch3:test` | ✅ PASS | 96/96 assertions passed across all 14 scenarios (including enhanced real-outage Scenario 13) |
| Batch 2 Verification Suite | `npm run batch2:test` | ✅ PASS | 25/25 assertions passed across all 9 outbox/persistence scenarios |
| Batch 1 Verification Suite | `npm run batch1:test` | ✅ PASS | 24/24 assertions passed (concurrency, idempotency, duplicate jobs, uncertain outcome, soft delete) |
| TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero errors, clean compilation |
| Production DB Integrity | Direct SQL inspection | ✅ PASS | `reachinbox` database 100% untouched (6 baseline tables) |


---

## [Entry 011] - 2026-11-17 - Phase 1 Batch 4: Distributed Rate Limiting and Minimum Send Spacing

**Scope:** Batch 4 – Distributed Rate Limiting and Minimum Send Spacing  
**Branch:** `feat/database-foundation`  
**Starting Baseline Commit:** `b64a6bd`  
**Engineer:** Senior Backend Engineer  

### Implementation Summary

1. **Global Hourly Limit Configuration (`src/config/index.ts`):**
   - Added `globalHourlyLimit` to application configuration (`config.app.globalHourlyLimit`), reading from `GLOBAL_EMAILS_PER_HOUR`.
   - Defaults to 0 (disabled), permitting unconstrained throughput when no global limit is configured.

2. **Atomic Unified Rate Limit & Spacing Reservation (`src/services/rateLimiter.ts`):**
   - Implemented `UNIFIED_RATE_LIMIT_LUA`: An atomic Redis Lua script coordinating all 4 limits in a single atomic transaction:
     - Minimum send spacing (`rate-limit:spacing:last-send`) with configurable delay window (`ARGV[1]`).
     - Global hourly limit (`rate-limit:global:hour`) with rolling 3600-second window.
     - Campaign-specific hourly limit (`rate-limit:campaign:<id>:hour`) with 3600-second window.
     - Sender-specific hourly limit (`rate-limit:sender:<id>:hour`) with 3600-second window.
   - **Atomicity & Non-Partial Invariant:** The Lua script evaluates all conditions before consuming any quota or setting timestamps. If any single check fails (spacing, global, campaign, or sender), zero keys are incremented or touched.
   - **Distributed Clock Synchronization:** Utilizes `redis.call('TIME')` directly on the Redis server for consistent distributed time evaluation across multiple worker processes.
   - **Zero Limit Disabling:** Global limit of 0 disables global throttling check. Sender and campaign limits are evaluated only when active and configured > 0.
   - Implemented `reserveSendSlot(options)` returning typed `RateLimitReservationResult` indicating whether the send slot was reserved, reason for restriction (`spacing`, `global_hourly_limit`, `campaign_hourly_limit`, `sender_hourly_limit`), and wait duration in milliseconds.
   - Retained backward-compatible helper functions (`checkRateLimit`, `checkSenderRateLimit`, `checkGlobalRateLimit`).

3. **Safe Delayed Rescheduling in Worker (`src/workers/emailWorker.ts`):**
   - Replaced uncoordinated multi-step rate limiting and spacing checks with the unified `reserveSendSlot()` call.
   - On limit restriction:
     - Atomically releases the PostgreSQL delivery claim via `releaseDeliveryClaim()`, setting delivery status back to `retry_wait` and persisting `next_attempt_at = NOW() + waitMs`.
     - Preserves existing Slack alert integration for campaign hourly rate limit exhaustion.
     - Moves BullMQ job to delayed set using `await job.moveToDelayed(Date.now() + waitMs, token)` and throws BullMQ `DelayedError` to cleanly exit without failing the job or creating duplicate records.
   - Survives worker crashes and restarts without re-sending or losing queue persistence.

4. **Batch 4 Acceptance Test Suite (`src/scripts/testBatch4RateLimitingAndSpacing.ts`):**
   - Implemented 10 comprehensive verification scenarios:
     1. Unified atomic reservation across all four limits.
     2. Zero partial increments when any limit blocks.
     3. Minimum send spacing enforcement across concurrent workers.
     4. Campaign hourly limit enforcement and delayed rescheduling.
     5. Shared sender hourly limit coordination across multiple campaigns.
     6. Global hourly limit enforcement and disablement when set to 0.
     7. Safe release of delivery claim and transition to `retry_wait` on restriction.
     8. Delayed job survival across worker restart with zero duplicate sends.
     9. Slack alert preservation for campaign rate limits.
     10. Delivery state integrity and single SMTP send verification.

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Batch 4 Verification Suite | `npm run batch4:test` | ✅ PASS | 51/51 assertions passed across all 10 scenarios |
| Batch 3 Regression Suite | `npm run batch3:test` | ✅ PASS | 96/96 assertions passed across all 14 scenarios |
| Batch 2 Regression Suite | `npm run batch2:test` | ✅ PASS | 25/25 assertions passed across all 9 outbox/persistence scenarios |
| Batch 1 Regression Suite | `npm run batch1:test` | ✅ PASS | 24/24 assertions passed (concurrency, idempotency, duplicate jobs, uncertain outcome, soft delete) |
| TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero errors, clean compilation |
| Production DB Integrity | Direct SQL inspection | ✅ PASS | `reachinbox` database 100% untouched |

---

## [Entry 012] - 2026-11-17 - Phase 1 Batch 5: Smart Campaign Preflight (Backend Only)

**Scope:** Batch 5 – Smart Campaign Preflight & Delivery Forecast
**Branch:** `feat/database-foundation`
**Starting Baseline Commit:** `5ede7a8`
**Engineer:** Senior Backend Engineer

### Implementation Summary

1. **Recipient Validation Engine (`src/services/preflightService.ts`):**
   - **Delimited & Plain Text Parsing:** Implemented `parseRawContent()` with automatic delimiter detection (`,`, `;`, `\t`), UTF-8 BOM stripping, escaped quote handling (`""`), and newline normalization. Handles headered and headerless CSVs, line-delimited plain text, and direct JSON recipient arrays.
   - **Malformed & Edge Case Safety:** Safe rejection for binary content (`\0`), missing email header columns, empty files, and oversized uploads (>5MB) without unhandled exceptions.
   - **Multi-Level Deduplication & Integrity:**
     - Validates format compliance using standard RFC 5322 regex.
     - Detects in-batch duplicates with case-insensitive normalization, placing duplicates into `duplicates` list with row numbers and descriptive reasons.
     - Performs PostgreSQL lookup to identify recipients that already exist within the targeted campaign (`existing` list).
   - **Summary Counts:** Generates exact counts (`total_rows`, `valid_count`, `invalid_count`, `duplicate_count`, `existing_count`).

2. **Sender Capacity & Delivery Forecast Engine (`src/services/preflightService.ts`):**
   - **Read-Only Capacity Inspection:**
     - Evaluates sender hourly capacity, remaining quota, and rolling window TTL from Redis.
     - Evaluates campaign hourly capacity and remaining quota.
     - Evaluates global hourly capacity via `getGlobalHourlyLimit()`, cleanly reflecting disabled state when set to 0.
     - Evaluates minimum spacing constraints (`sendDelayMs`) and derives theoretical maximum hourly rate.
     - Queries BullMQ queue job counts (`waiting` + `active`) to factor in existing backlog.
   - **Bottleneck Detection:** Identifies the primary bottleneck (`campaign_hourly_limit`, `sender_hourly_limit`, `global_hourly_limit`, or `minimum_spacing`).
   - **Delivery Forecasting:** Computes realistic multi-hour delivery start time, completion time, and duration in seconds. Accurately predicts multi-hour roll-over when recipient count exceeds current-hour capacity.
   - **Disclaimers & Disclosures:** Marks forecast as approximate (`is_approximate: true`), provides explicit operating assumptions, and produces actionable warnings for queue backlog, multi-hour delays, or exhausted quotas.

3. **HTTP API Integration (`src/controllers/preflightController.ts`, `src/routes/`):**
   - Exposes authenticated endpoints:
     - `POST /campaigns/preflight`
     - `POST /campaigns/:id/preflight`
     - `POST /preflight`
   - Scopes all queries strictly to the authenticated user (`req.user.id`).
   - Validates input sizes (rejects uploads >5MB with 413 Payload Too Large) and payload structure (UUIDs, limits, timestamps).
   - Guarantees 100% read-only operation: zero database inserts, zero BullMQ jobs, and zero rate-limit reservations.

4. **Batch 5 Acceptance Test Suite (`src/scripts/testBatch5Preflight.ts`):**
   - 90 rigorous test assertions covering valid CSV parsing, invalid format detection, in-upload duplicate detection, campaign pre-existence detection, malformed/oversized file safety, exact validation counts, global/sender/campaign/spacing capacity calculations, forecast duration accuracy, absolute zero-side-effect verification, user isolation, and controller HTTP status codes (200, 400, 401, 413).

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Batch 5 Verification Suite | `npm run batch5:test` | ✅ PASS | 90/90 assertions passed across all 12 scenarios + controller unit tests |
| Batch 4 Regression Suite | `npm run batch4:test` | ✅ PASS | 51/51 assertions passed across all 10 scenarios |
| Batch 3 Regression Suite | `npm run batch3:test` | ✅ PASS | 96/96 assertions passed across all 14 scenarios |
| Batch 2 Regression Suite | `npm run batch2:test` | ✅ PASS | 25/25 assertions passed across all 9 outbox/persistence scenarios |
| Batch 1 Regression Suite | `npm run batch1:test` | ✅ PASS | 24/24 assertions passed (concurrency, idempotency, duplicate jobs, uncertain outcome, soft delete) |
| TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero errors, clean compilation |
| Production DB Integrity | Direct SQL inspection | ✅ PASS | `reachinbox` database 100% untouched |

---

## [Entry 013] - 2026-11-17 - Phase 1 Batch 5.1: Preflight Forecast Accuracy

**Scope:** Batch 5.1 – Preflight Forecast Accuracy & PostgreSQL Limit Integrity
**Branch:** `feat/database-foundation`
**Starting Baseline Commit:** `0a31a22`
**Engineer:** Senior Backend Engineer

### Implementation Summary

1. **Authoritative PostgreSQL Limit Derivation (Bug 1 Fix):**
   - Refactored `calculateCapacityAndForecast()` in `src/services/preflightService.ts` to derive sender and campaign limits strictly from authenticated PostgreSQL records (`senders` and `campaigns` tables).
   - Removed vulnerability where a client-supplied `hourly_limit` parameter could silently overwrite an existing campaign's configured limit.
   - Preserved `hourly_limit` strictly for pre-creation draft campaigns that have no existing database record.
   - Exposes client-supplied parameter on existing campaigns as an isolated `what_if_scenario` simulation (`WhatIfScenarioResult`) without misrepresenting actual configured capacity.

2. **Accurate Rate-Limit Reset Estimation (Bug 2 Fix):**
   - Implemented `calculateResetWait()` in `src/services/preflightService.ts`:
     - Inspects each applicable rate limit counter (campaign, sender, global) to identify specifically which constraint(s) are currently exhausted or will become exhausted mid-batch (spillover).
     - Calculates reset wait duration using strictly the relevant exhausted counters, completely eliminating the flawed `Math.min()` of unrelated non-exhausted counters.
     - When multiple limits are simultaneously exhausted, computes the maximum TTL across all exhausted constraints, ensuring dispatches resume only after all required constraints permit sending.
     - Updates warning messages to dynamically specify the exact exhausted constraint(s).

3. **Accurate Validation Error Description:**
   - Updated email format validation error reason from `'Invalid email address format (RFC 5322 violation)'` to `'Invalid email address format'`, removing unverified claims of full RFC 5322 compliance.

4. **Batch 5.1 Acceptance Tests (`src/scripts/testBatch5Preflight.ts`):**
   - Added Tests 13–20 verifying:
     - Client cannot override actual configured campaign capacity (500 limit ignored, 10 maintained).
     - Campaign limit derived directly from PostgreSQL updates (35).
     - Sender limit derived directly from PostgreSQL updates (85).
     - Campaign limit exhausted while sender is not (uses 1800s campaign TTL, excludes 500s sender TTL).
     - Sender limit exhausted while campaign is not (uses 2200s sender TTL, excludes 400s campaign TTL).
     - Multiple limits exhausted simultaneously (uses max TTL = 2500s across 1200s, 2500s, 800s).
     - Spillover reset estimation correctly identifies exhausted constraint.
     - Accurate email format validation description without RFC 5322 claims.

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Batch 5.1 Verification Suite | `npm run batch5:test` | ✅ PASS | 115/115 assertions passed across all 20 test sections |
| Batch 4 Regression Suite | `npm run batch4:test` | ✅ PASS | 51/51 assertions passed across all 10 scenarios |
| Batch 3 Regression Suite | `npm run batch3:test` | ✅ PASS | 96/96 assertions passed across all 14 scenarios |
| Batch 2 Regression Suite | `npm run batch2:test` | ✅ PASS | 25/25 assertions passed across all 9 outbox/persistence scenarios |
| Batch 1 Regression Suite | `npm run batch1:test` | ✅ PASS | 24/24 assertions passed (concurrency, idempotency, duplicate jobs, uncertain outcome, soft delete) |
| TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero errors, clean compilation |
| Production DB Integrity | Direct SQL inspection | ✅ PASS | `reachinbox` database 100% untouched |

---

## [Entry 014] - 2026-11-17 - Phase 1 Batch 5.2: Correct What-If Forecast Simulation

**Scope:** Batch 5.2 – Correct What-If Forecast Simulation & Bottleneck Calculation
**Branch:** `feat/database-foundation`
**Starting Baseline Commit:** `4b6e2e6`
**Engineer:** Senior Backend Engineer

### Implementation Summary

1. **Independent Simulated Campaign Remaining Capacity:**
   - In `src/services/preflightService.ts`, calculated simulated campaign remaining capacity directly as `Math.max(0, hourlyLimit - campaignUsed)`.
   - Prevented false capping where exhausted actual campaign capacity previously collapsed the simulation to 0 even if a higher simulated limit was specified.
   - Bounded simulated capacity at zero when the simulated limit is less than or equal to already consumed campaign usage.

2. **Accurate Simulated Window Capacity Comparison:**
   - Compared `simulatedCampaignRemaining` against actual sender and global remaining capacity:
     `simulatedCurrentHourRemaining = Math.max(0, Math.min(...simHourLimits))`.
   - Exposed `simulated_campaign_remaining` and `simulated_current_hour_remaining` in `WhatIfScenarioResult`.

3. **Independent Simulated Rate and Bottleneck Analysis:**
   - Evaluated simulated hourly rates independently across simulated campaign limit, sender limit, global limit, and minimum spacing rate.
   - Accurately identifies `primary_bottleneck` for the simulation (e.g. sender limit or global limit becoming the bottleneck when campaign limit is simulated higher).

4. **Independent Reset-Wait Evaluation:**
   - Evaluated `calculateResetWait()` independently with the simulated campaign capacity rather than reusing actual scenario reset waits.
   - Prevents multi-hour delay forecasts when an increased simulated limit eliminates the campaign bottleneck, while computing appropriate reset wait when the simulated scenario itself is exhausted.

5. **Read-Only Invariant & Configured State Protection:**
   - Guaranteed 100% read-only simulation: zero Redis quota reservations and zero PostgreSQL modifications.
   - Actual configured campaign capacity, effective hourly rate, primary bottleneck, and primary forecast remain completely untouched across all simulations.

6. **Batch 5.2 Acceptance Tests (`src/scripts/testBatch5Preflight.ts`):**
   - Added Test Section 21 asserting all required scenarios:
     - Scenario A: Simulated limit higher than actual limit (campaign limit 35, usage 30; simulate 50 -> remaining 20, spacing duration 18s).
     - Scenario B: Simulated limit lower than already-consumed usage (usage 30; simulate 25 -> remaining bounded at 0, requires reset wait >= 1800s).
     - Scenario C: Simulated limit lower than actual configured limit but still available (usage 10; simulate 25 -> remaining 15, bottleneck `campaign_hourly_limit`).
     - Scenario D: Sender limit becomes simulated bottleneck (sender limit 85; simulate 150 -> effective rate 85, bottleneck `sender_hourly_limit`).
     - Scenario E: Global limit becomes simulated bottleneck (global limit 40; simulate 100 -> effective rate 40, bottleneck `global_hourly_limit`).
     - Scenario F: Actual forecast remains unchanged across all simulations (limit 35, rate 35, bottleneck `campaign_hourly_limit`).
     - Read-only verification: confirmed rate-limit keys were neither created nor mutated.

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Batch 5 Verification Suite | `npm run batch5:test` | ✅ PASS | 142/142 assertions passed across all 21 test sections |
| Batch 4 Regression Suite | `npm run batch4:test` | ✅ PASS | 51/51 assertions passed across all 10 scenarios |
| Batch 3 Regression Suite | `npm run batch3:test` | ✅ PASS | 96/96 assertions passed across all 14 scenarios |
| Batch 2 Regression Suite | `npm run batch2:test` | ✅ PASS | 25/25 assertions passed across all 9 outbox/persistence scenarios |
| Batch 1 Regression Suite | `npm run batch1:test` | ✅ PASS | 24/24 assertions passed (concurrency, idempotency, duplicate jobs, uncertain outcome, soft delete) |
| TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero errors, clean compilation |
| Production DB Integrity | Direct SQL inspection | ✅ PASS | `reachinbox` database 100% untouched |

---

## [Entry 015] - 2026-11-17 - Phase 1 Batch 6: Email Failure & Recovery Center (Backend Only)

**Scope:** Batch 6 – Failure Monitoring, Attempt History, Safe Manual Retry, Unknown Delivery Resolution & Campaign Lifecycle
**Branch:** `feat/database-foundation`
**Starting Baseline Commit:** `e428c9b`
**Engineer:** Senior Backend Engineer

### Implementation Summary

1. **Failure Monitoring & Attempt History (`src/services/recoveryService.ts`, `src/controllers/recoveryController.ts`, `src/routes/deliveries.ts`):**
   - Implemented authenticated REST endpoints:
     - `GET /deliveries` (multi-criteria filtering by status, campaign, sender, error classification, date range; pagination with limit/offset/page; stable sorting).
     - `GET /deliveries/failed` (convenience view for failed deliveries).
     - `GET /deliveries/unknown` (convenience view for ambiguous/uncertain deliveries requiring operator review).
     - `GET /deliveries/:id` (individual delivery details with attempt history, resolutions, and retry eligibility).
     - `GET /deliveries/:id/attempts` (complete immutable attempt audit history).
     - `GET /campaigns/:id/deliveries` (campaign-scoped delivery listing).
   - Strict multi-tenant security: every query joins `campaigns c ON c.id = ed.campaign_id WHERE c.user_id = $1`. Cross-tenant delivery access is rejected with HTTP 404/403.
   - Sensitive credential protection: sender credential columns (`smtp_pass`, `smtp_user`) are strictly excluded from queries.

2. **Retry Eligibility Engine (`evaluateRetryEligibility`):**
   - Transparently evaluates and displays retry eligibility and reasons:
     - `transient_rejection` and `connection_failure`: eligible.
     - `operator_confirmed_not_accepted`: eligible.
     - `permanent_rejection`: ineligible (hard bounce, invalid mailbox, auth failure).
     - `ambiguous_outcome` / `stale_claim_reconciliation` (`unknown`): ineligible without operator resolution.
     - `sent`, `cancelled`, and `in-flight`: strictly ineligible.
     - Enforces policy attempt limits (`attempt_count >= maxAttempts` -> ineligible).

3. **Safe Manual Retry (`manualRetryDelivery`):**
   - Atomic state transition via PostgreSQL `FOR UPDATE OF ed`.
   - Validates failure classification and eligibility rules.
   - Prevents duplicate manual retry requests: verifies no active outbox record is in progress and uses deterministic deduplication key `retry_${delivery.id}_attempt_${nextAttemptNumber}` with `ON CONFLICT (deduplication_key) DO NOTHING`.
   - Disallows retrying sent, cancelled, or unknown deliveries.
   - Publishes outbox event immediately via `outboxPublisher`.

4. **Unknown Delivery Review & Resolution (`resolveUnknownDelivery`, `008_create_operator_resolutions_schema.sql`):**
   - Created forward-only migration `008_create_operator_resolutions_schema.sql` adding `delivery_resolutions` audit table.
   - Supported decisions:
     - `confirmed_accepted`: reconciles delivery and attempt to `sent` without fabricating SMTP metadata (codes and message IDs left as NULL).
     - `confirmed_not_accepted`: transitions delivery to `failed` with classification `operator_confirmed_not_accepted`, making it eligible for manual retry while never automatically retrying.
   - Requires mandatory non-empty reason and verified campaign ownership.
   - Persists immutable audit record in `delivery_resolutions`.

5. **Campaign Lifecycle Controls (`pauseCampaign`, `resumeCampaign`, `cancelCampaign`):**
   - `POST /campaigns/:id/pause`: atomically sets campaign to `paused`. Prevents new delivery claims (since `claimDelivery` checks `c.status = 'sending'`). Reports in-flight dispatches completing.
   - `POST /campaigns/:id/resume`: transitions paused campaign to `sending` (or `scheduled`). Republishes only eligible outstanding deliveries (`pending`, `scheduled`, `retry_wait`) through outbox. Strictly excludes `sent`, `unknown`, `failed`, `cancelled`.
   - `POST /campaigns/:id/cancel`: transitions campaign to `cancelled`. Atomically cancels outstanding deliveries and outbox records. Strictly preserves `sent` and `unknown` deliveries.
   - All lifecycle endpoints are idempotent across repeated calls.

6. **Batch 6 Acceptance Tests (`src/scripts/testBatch6Recovery.ts`):**
   - 12 comprehensive scenarios verifying cross-tenant isolation, failure listing/pagination, attempt history preservation, retry eligibility, concurrent retry deduplication, sent/unknown retry refusal, operator resolution without metadata fabrication, mandatory reason audit, pause claim prevention, resume safe republication, cancel protection, and production DB untouched.

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Batch 6 Verification Suite | `npm run batch6:test` | ✅ PASS | 75/75 assertions passed across all 12 scenarios |
| Batch 5 Verification Suite | `npm run batch5:test` | ✅ PASS | 142/142 assertions passed across all 21 test sections |
| Batch 4 Regression Suite | `npm run batch4:test` | ✅ PASS | 51/51 assertions passed across all 10 scenarios |
| Batch 3 Regression Suite | `npm run batch3:test` | ✅ PASS | 96/96 assertions passed across all 14 scenarios |
| Batch 2 Regression Suite | `npm run batch2:test` | ✅ PASS | 25/25 assertions passed across all 9 outbox/persistence scenarios |
| Batch 1 Regression Suite | `npm run batch1:test` | ✅ PASS | 24/24 assertions passed (concurrency, idempotency, duplicate jobs, uncertain outcome, soft delete) |
| TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero errors, clean compilation |
| Production DB Integrity | Direct SQL inspection | ✅ PASS | `reachinbox` database 100% untouched |

---

## 2026-11-17 – Entry 016: Batch 6.1 – Atomic Campaign Pause and Cancellation

### Scope & Objective
Fix two campaign-control defects in campaign lifecycle management:
1. **Bug 1: Atomic Campaign Cancellation (`cancelCampaign`)**:
   - Wrap campaign cancellation in an explicit PostgreSQL transaction (`BEGIN ... COMMIT / ROLLBACK`) using a dedicated client.
   - Lock the campaign row for update (`FOR UPDATE`) and verify user ownership before modifying any state.
   - Atomically update campaign status to `cancelled`, cancel eligible delivery records (`pending`, `scheduled`, `retry_wait`), and cancel pending/processing outbox events (`delivery_outbox`) in the same transaction.
   - Ensure complete rollback if any operation fails (`injectFailure` testing hook supported).
   - Strictly preserve `sent` and `unknown` deliveries without modification.
   - Preserve active SMTP operations (`status = 'sending' AND lease_expires_at > NOW()`) and accurately report their count in `in_flight_count`.
   - Ensure repeated cancellation requests are idempotent.
2. **Bug 2: Synchronize Pause/Cancel with Worker Claims (`pauseCampaign`, `cancelCampaign`, `claimDelivery`)**:
   - Establish a consistent PostgreSQL row-locking hierarchy: Parent (`campaigns`) first, Child (`email_deliveries`) second.
   - Update `claimDelivery` in `deliveryService.ts` to acquire `FOR SHARE OF c` on `campaigns` and `FOR UPDATE OF ed SKIP LOCKED` on `email_deliveries`.
   - Update `pauseCampaign` to use an explicit transaction and acquire `FOR UPDATE` on `campaigns`.
   - When `pauseCampaign` or `cancelCampaign` acquires `FOR UPDATE`, racing claims either complete before the transition (and are reported in `in_flight_count`), or are rejected after the transition (`claimDelivery` returns `null` because `c.status = 'sending'` is false).
   - Eliminate deadlocks, race conditions, and never hold database transactions open across external network operations.

### Key Changes
1. `backend/src/types/recovery.types.ts`:
   - Added `CancelCampaignOptions { injectFailure?: boolean; }`.
2. `backend/src/services/deliveryService.ts`:
   - Updated `claimDelivery()` query to join `campaigns c` and lock `FOR SHARE OF c`, `FOR UPDATE OF ed SKIP LOCKED`.
   - Guaranteed consistent locking order (`campaigns` -> `email_deliveries`).
3. `backend/src/services/recoveryService.ts`:
   - Refactored `pauseCampaign()` and `cancelCampaign()` to manage dedicated clients from `Pool` or reuse existing `PoolClient` without reconnection conflicts.
   - Implemented explicit transactions (`BEGIN ... COMMIT / ROLLBACK`).
   - Added `SELECT ... FROM campaigns WHERE id = $1 AND user_id = $2 FOR UPDATE`.
   - Counted active dispatches (`status = 'sending' AND lease_expires_at > NOW()`) as `in_flight_count`.
   - Updated campaign status, eligible delivery statuses (`status IN ('pending', 'scheduled', 'retry_wait')`), and pending outbox events within the single atomic transaction.
   - Supported rollback verification through `options?.injectFailure`.
4. `backend/src/scripts/testBatch6Recovery.ts`:
   - Added Tests 13–19 verifying:
     - Test 13: Atomic campaign cancellation commits all tables (`campaigns`, `email_deliveries`, `delivery_outbox`).
     - Test 14: Injected cancellation failure rolls back all tables completely.
     - Test 15: Concurrent cancellation requests remain idempotent.
     - Test 16: Pause racing with delivery claiming safely synchronized.
     - Test 17: Cancellation racing with delivery claiming safely synchronized.
     - Test 18: In-flight dispatches counted and active dispatches preserved.
     - Test 19: Strict preservation of sent and unknown deliveries across cancellation.

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Batch 6 & 6.1 Verification Suite | `npm run batch6:test` | ✅ PASS | 108/108 assertions passed across all 19 test scenarios |
| Batch 5 Verification Suite | `npm run batch5:test` | ✅ PASS | 142/142 assertions passed across all 21 test sections |
| Batch 4 Regression Suite | `npm run batch4:test` | ✅ PASS | 51/51 assertions passed across all 10 scenarios |
| Batch 3 Regression Suite | `npm run batch3:test` | ✅ PASS | 96/96 assertions passed across all 14 scenarios |
| Batch 2 Regression Suite | `npm run batch2:test` | ✅ PASS | 25/25 assertions passed across all 9 outbox/persistence scenarios |
| Batch 1 Regression Suite | `npm run batch1:test` | ✅ PASS | 24/24 assertions passed (concurrency, idempotency, duplicate jobs, uncertain outcome, soft delete) |
| TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero errors, clean compilation |
| Production DB Integrity | Direct SQL inspection | ✅ PASS | `reachinbox` database 100% untouched |

---

## 2026-11-17 – Entry 017: Batch 7A – Operations Intelligence Data Service

### Scope & Objective
Implement a dedicated Operations Intelligence Data Service (`operationsIntelligenceService.ts`) providing authoritative, aggregated operational telemetry across campaigns, deliveries, attempts, senders, queues, and rate limiters. This service establishes the trusted data layer for operational monitoring and the upcoming AI Delivery Operations Copilot.

### Architectural Invariants & Key Implementations
1. **Multi-Tenant Security & Parameterized SQL**:
   - Every function strictly requires and enforces authenticated `userId`.
   - All queries join on `campaigns.user_id = $1` or `senders.user_id = $1`.
   - Never exposes SMTP passwords, OAuth tokens, or secrets (`s.smtp_pass` is excluded).
   - Minimizes PII: no recipient names or email addresses in operational context documents.
2. **Campaign Intelligence (`getCampaignIntelligence`)**:
   - Computes total campaigns and status distribution (`draft`, `scheduled`, `sending`, `paused`, `completed`, `cancelled`).
   - Maps aggregate deliveries across all statuses (`sent`, `failed`, `pending`, `retry_wait`, `unknown`, `scheduled`, `cancelled`).
   - Calculates confirmed `success_rate` and `failure_rate` using terminal deliveries (`sent / (sent + failed)`).
   - Identifies high failure campaigns ($\ge 20\%$ failure rate or $\ge 5$ failures).
3. **Delivery Failure Intelligence (`getDeliveryFailureIntelligence`)**:
   - Reports failed and unknown deliveries separately.
   - Categorizes error classifications (`permanent_rejection`, `transient_rejection`, `connection_failure`, `ambiguous_outcome`, etc.).
   - Distinguishes transient vs. permanent vs. uncertain failure distributions.
   - Summarizes top failure reasons with bounded sample delivery IDs for citation.
   - Tracks attempt distributions and identifies deliveries approaching retry limits ($\text{attempt\_count} \ge 2$).
4. **Sender Performance Intelligence (`getSenderPerformanceIntelligence`)**:
   - Evaluates performance sender-by-sender using isolated CTEs to prevent Cartesian products.
   - Distinguishes total dispatch attempts from unique recipient deliveries.
   - Distinguishes confirmed SMTP acceptance (`RFC 5321 250 OK`) from recipient inbox delivery.
   - Assigns objective, data-driven health states (`healthy`, `degraded`, `critical`, `idle`).
5. **Queue Intelligence (`getQueueIntelligence`)**:
   - Inspects BullMQ/Redis queue backlog (`waiting`, `active`, `delayed`, `failed`).
   - Enforces campaign-level queue isolation: user-scoped counts reflect only jobs matching the user's campaign IDs.
   - Gracefully handles Redis disconnection/outage with `is_available: false` and explicit diagnosis without throwing.
6. **Operational Bottleneck Analysis (`analyzeOperationalBottlenecks`)**:
   - Evaluates campaign hourly limits, global rate limits, sender rate limits, minimum send spacing, excessive retries, queue backlogs, and unresolved unknown outcomes.
   - Reports observed facts, calculated indicators, actionable recommendations, and underlying source IDs.
7. **Structured Operations Context (`getOperationsContext`)**:
   - Produces a sanitized, compact, citation-friendly operations document for future LLM consumption.
   - Includes data freshness timestamp, investigation recommendations, and documented metric definitions.
8. **Strict Read-Only Guarantee**:
   - Performs zero database or queue mutations during intelligence queries.

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Batch 7A Verification Suite | `npm run batch7a:test` | ✅ PASS | 92/92 assertions passed across all 13 test scenarios |
| Batch 6 & 6.1 Verification Suite | `npm run batch6:test` | ✅ PASS | 108/108 assertions passed across all 19 test scenarios |
| Batch 5 Verification Suite | `npm run batch5:test` | ✅ PASS | 142/142 assertions passed across all 21 test sections |
| Batch 4 Regression Suite | `npm run batch4:test` | ✅ PASS | 51/51 assertions passed across all 10 scenarios |
| Batch 3 Regression Suite | `npm run batch3:test` | ✅ PASS | 96/96 assertions passed across all 14 scenarios |
| Batch 2 Regression Suite | `npm run batch2:test` | ✅ PASS | 25/25 assertions passed across all 9 outbox/persistence scenarios |
| Batch 1 Regression Suite | `npm run batch1:test` | ✅ PASS | 24/24 assertions passed (concurrency, idempotency, duplicate jobs, uncertain outcome, soft delete) |
| TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero errors, clean compilation |
| Production DB Integrity | Direct SQL inspection | ✅ PASS | `reachinbox` database 100% untouched |

---

## 2026-11-17 – Entry 018: Batch 7A.1 – Operations Intelligence Accuracy and Queue Isolation

### Scope & Objective
Refine the Operations Intelligence Data Service (`operationsIntelligenceService.ts`) to fix two critical accuracy and data isolation defects:
1. **Attempt-Level Metrics Accuracy**:
   - Derive confirmed SMTP acceptances strictly from `email_attempts` records with status `'sent'` having genuine SMTP acceptance evidence (`smtp_response_code` or `smtp_message_id`).
   - Derive confirmed failures strictly from `email_attempts` records with status `'failed'`.
   - Derive unknown outcomes strictly from `email_attempts` records with status `'unknown'`.
   - Prevent operator-resolved accepted deliveries (without genuine SMTP evidence) from being conflated with confirmed SMTP acceptances.
   - Correct `getDeliveryFailureIntelligence().total_attempts` to directly count `email_attempts` via `COUNT(ea.id)` rather than grouping delivery classifications.
   - Maintain strict separation between unique delivery targets and total dispatch attempts.
   - Exclude unknown outcomes from success and failure rate denominators (`sent / (sent + failed)`).
2. **Queue Tenant Isolation & Complete Count Handling**:
   - Completely eliminate exposure of cross-tenant global queue counts and backlogs in tenant-facing responses and AI context documents (`global_counts: null`, `count_scope: 'tenant_scoped'`).
   - Implement chunked queue inspection (`scanStateJobs`) paginating in slices of 500 up to `sampleLimit` (default: 2500) to accurately support BullMQ queue depths > 500 jobs without missing jobs or causing memory exhaustion.
   - Explicitly flag partial sampling via `is_partial: true`, `sample_limit`, and diagnostic notes whenever queue depth exceeds the sample limit; never represent a truncated count as exact.
   - Gracefully handle Redis unavailability without fabricating exact counts.

### Key Implementations & Enhancements
1. **Attempt Metric Derivation (`operationsIntelligenceService.ts` & `operationsIntelligence.types.ts`)**:
   - `getSenderPerformanceIntelligence`: Updated CTEs so `delivery_stats` provides `unique_deliveries`, `sent_deliveries`, `failed_deliveries`, `unknown_deliveries`, while `attempt_stats` provides `total_attempts`, `confirmed_smtp_acceptances` (checking `smtp_response_code IS NOT NULL OR smtp_message_id IS NOT NULL`), `confirmed_failures`, and `unknown_outcomes`.
   - `getDeliveryFailureIntelligence`: Total attempts query simplified to `SELECT COUNT(ea.id)::int AS total_attempts FROM email_attempts ea JOIN email_deliveries ed ON ed.id = ea.delivery_id JOIN campaigns c ON c.id = ed.campaign_id WHERE c.user_id = $1`.
2. **Queue Isolation & Pagination (`operationsIntelligenceService.ts`)**:
   - Implemented `scanStateJobs` helper to fetch BullMQ jobs in chunks of 500 up to `sampleLimit`.
   - Populated `user_backlog`, `user_counts`, `count_scope: 'tenant_scoped'`, `is_partial`, and `sample_limit`.
   - Set `global_counts: null` and strictly tenant-scoped queue summaries in `getOperationsContext`.
3. **Verification Test Suite Expansion (`testBatch7AOperationsIntelligence.ts`)**:
   - Added Test 3B: Verifying operator-confirmed acceptance without SMTP evidence is not counted as a verified SMTP acceptance.
   - Updated Test 5: Asserted `failIntel.total_attempts === 13`.
   - Updated Tests 6, 7 & 12: Verified tenant isolation, zero global queue leak, and tenant-scoped backlog.
   - Added Test 7B: Tested queue depth > 500 jobs (601 waiting jobs) with pagination and bounded partial scan (`sampleLimit = 300` -> `is_partial === true`).

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Batch 7A & 7A.1 Verification Suite | `npm run batch7a:test` | ✅ PASS | 104/104 assertions passed across all 15 test scenarios |
| Batch 6 & 6.1 Verification Suite | `npm run batch6:test` | ✅ PASS | 108/108 assertions passed across all 19 test scenarios |
| Batch 5 Verification Suite | `npm run batch5:test` | ✅ PASS | 142/142 assertions passed across all 21 test sections |
| Batch 4 Regression Suite | `npm run batch4:test` | ✅ PASS | 51/51 assertions passed across all 10 scenarios |
| Batch 3 Regression Suite | `npm run batch3:test` | ✅ PASS | 96/96 assertions passed across all 14 scenarios |
| Batch 2 Regression Suite | `npm run batch2:test` | ✅ PASS | 25/25 assertions passed across all 9 outbox/persistence scenarios |
| Batch 1 Regression Suite | `npm run batch1:test` | ✅ PASS | 24/24 assertions passed (concurrency, idempotency, duplicate jobs, uncertain outcome, soft delete) |
| TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero errors, clean compilation |
| Production DB Integrity | Direct SQL inspection | ✅ PASS | `reachinbox` database 100% untouched |

---

## 2026-11-17 – Entry 019: Batch 7A.2 – Shared Rate-Limit Privacy

### Scope & Objective
Protect shared global rate-limit telemetry and system-wide throughput metrics exposed to ordinary tenant users and the future AI Operations Copilot context in `operationsIntelligenceService.ts`:
1. **Shared Rate-Limit Privacy**:
   - Suppress exposure of exact global system-wide usage counts (`usage`) and usage/limit ratios (`usage / globalLimit`, e.g. `500/500`) to tenant responses.
   - Prevent internal platform environment configuration names (`GLOBAL_EMAILS_PER_HOUR`) and system-wide throughput from leaking into operational facts or AI context documents.
2. **Actionable Platform Throttling Alerts**:
   - Preserve clear tenant notifications that shared platform throttling is active and outbound deliveries are temporarily delayed.
   - Report tenant-safe operational recommendations: capacity resets hourly and dispatches resume automatically without manual intervention.
3. **Tenant-Specific Information Preservation**:
   - Maintain tenant-specific campaign hourly limit and sender hourly limit bottleneck metrics (`(${usage}/${limit} emails)`).
   - Ensure queue counts remain strictly tenant-scoped (`global_counts: null`).
4. **Strict Read-Only Verification**:
   - All operational bottleneck evaluations remain strictly non-mutating.

### Key Implementations & Enhancements
1. **Tenant-Safe Bottleneck Telemetry (`operationsIntelligenceService.ts`)**:
   - Updated `analyzeOperationalBottlenecks`:
     - `observed_fact`: `'Shared platform hourly delivery capacity limit reached. Outbound dispatches are temporarily throttled.'`
     - `calculated_indicator`: `'Outbound delivery dispatches are temporarily paused for ~${ttl} seconds until the shared capacity window resets.'`
     - `recommendation`: `'Shared platform capacity resets hourly. Outbound dispatches will resume automatically; no tenant action required.'`
   - Zero exposure of other tenants' activity or cumulative platform email volumes.
2. **Verification Test Suite Expansion (`testBatch7AOperationsIntelligence.ts`)**:
   - Added `TEST 12B: Shared Global Rate-Limit Privacy and Tenant Isolation` (15 assertions) verifying:
     - Global rate-limit exhaustion is accurately detected (`global_rate_limit_exhausted`).
     - `observed_fact` contains no exact global usage numbers, ratios, or `GLOBAL_EMAILS_PER_HOUR`.
     - `calculated_indicator` and `recommendation` do not leak platform config or usage values.
     - Tenant-specific campaign and sender bottleneck details (`50/50 emails`, `100/100 emails`) are preserved.
     - In `getOperationsContext()`, no global usage, ratios, or platform config names leak into the AI context JSON.
     - Queue summaries remain tenant-scoped with zero global count leakage.

### Actual Test Results

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Batch 7A & 7A.2 Verification Suite | `npm run batch7a:test` | ✅ PASS | 119/119 assertions passed across all 16 test scenarios |
| Batch 6 & 6.1 Verification Suite | `npm run batch6:test` | ✅ PASS | 108/108 assertions passed across all 19 test scenarios |
| Batch 5 Verification Suite | `npm run batch5:test` | ✅ PASS | 142/142 assertions passed across all 21 test sections |
| Batch 4 Regression Suite | `npm run batch4:test` | ✅ PASS | 51/51 assertions passed across all 10 scenarios |
| Batch 3 Regression Suite | `npm run batch3:test` | ✅ PASS | 96/96 assertions passed across all 14 scenarios |
| Batch 2 Regression Suite | `npm run batch2:test` | ✅ PASS | 25/25 assertions passed across all 9 outbox/persistence scenarios |
| Batch 1 Regression Suite | `npm run batch1:test` | ✅ PASS | 24/24 assertions passed (concurrency, idempotency, duplicate jobs, uncertain outcome, soft delete) |
| TypeScript Build | `npm run build` (`tsc`) | ✅ PASS | Zero errors, clean compilation |
| Production DB Integrity | Direct SQL inspection | ✅ PASS | `reachinbox` database 100% untouched |
