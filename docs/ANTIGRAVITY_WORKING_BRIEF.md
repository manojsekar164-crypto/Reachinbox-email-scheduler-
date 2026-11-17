# ANTIGRAVITY WORKING BRIEF — ReachInbox Intelligent Email Delivery Platform

**Version:** 1.0.0  
**Repository:** `https://github.com/manojsekar164-crypto/Reachinbox-email-scheduler-.git`  
**Active Development Branch:** `feat/database-foundation`  
**Role:** Senior Backend Architect, PostgreSQL Engineer, and Distributed Systems Engineer  

---

## 1. System Mission & Core Constraints

ReachInbox is an intelligent, high-throughput email delivery and campaign scheduling platform. The mission is to transform the existing codebase into a bulletproof, production-grade distributed system while strictly honoring the following non-negotiable architectural mandates:

1. **ABSOLUTELY NO CRON JOBS:** No `crontab`, `node-cron`, `agenda`, `setInterval` polling, or cron libraries.
2. **BullMQ Delayed Jobs:** All scheduling must be exact UTC epoch-delayed BullMQ jobs (`delayMs = Math.max(0, scheduledAt.getTime() - Date.now())`).
3. **PostgreSQL as Permanent Source of Truth:** All persistent state (users, campaigns, recipients, delivery logs, senders, OAuth tokens) lives in PostgreSQL.
4. **Redis & BullMQ Durability:** Redis persists queued and delayed jobs across crashes and reboots.
5. **Crash & Restart Recovery:** Pending jobs must resume safely after worker or process restarts.
6. **No Blind Resending:** Emails already sent must never be resent under any circumstance.
7. **Database-Level Idempotency:** Every recipient delivery must be guarded by a PostgreSQL unique index and conflict-safe queries.
8. **Real SMTP Delivery:** Never fake SMTP success. No synthetic message IDs or simulated preview URLs on delivery failure; real errors must propagate for exponential retry and failure tracking.
9. **Shared Sender-Level Rate Limiting:** Enforce shared hourly rate limits per SMTP sender across multiple campaigns in addition to campaign-level rate limits.
10. **Configurable Worker Concurrency:** Concurrency must be environment-driven via `WORKER_CONCURRENCY` (defaulting safely to 2).
11. **Configurable Inter-Email Spacing:** Minimum inter-send delay must be configurable via `EMAIL_SEND_DELAY_MS` (default 2000ms) using atomic Redis Lua scripts.
12. **Real Integrations:** Google OAuth and Slack OAuth / Webhooks must remain real and fully functional.
13. **Preserve Existing Functionality:** Do not rewrite existing working features or break existing APIs.
14. **No Frontend Modifications During Phase 1:** Keep changes focused on the backend and database architecture.

---

## 2. Phase 1 Scope: Database Foundation & Delivery Reliability

Phase 1 focuses on hardening the database, eliminating critical vulnerabilities, and securing delivery mechanisms:

### 2.1 Database Migrations & Version Tracking
- Implement `schema_migrations` tracking table so migrations execute sequentially and idempotently without re-running existing statements.
- Add partial unique index on `email_logs (campaign_id, recipient_id) WHERE status = 'sent'` to eliminate race-condition double sending at the database level.
- Add `hourly_limit` column to `senders` table to support sender-level rate limiting.
- Synchronize `CampaignStatus` type and check constraints (`draft`, `scheduled`, `sending`, `completed`, `failed`).

### 2.2 At-Rest Credential Encryption
- Secure `senders.smtp_user` and `senders.smtp_pass` using AES-256-GCM authenticated encryption (derived from `ENCRYPTION_KEY`).
- Provide transparent encryption on write and decryption on read in `senderService` and `emailWorker`.
- Document `ENCRYPTION_KEY` in `backend/.env.example`.

### 2.3 Eliminating Fake SMTP Fallbacks
- Remove Tier 3 synthetic delivery record generation from `emailService.ts`.
- Ensure real SMTP errors propagate to BullMQ for exponential backoff retries (3 attempts).
- On final failure, persist accurate error messages in `email_logs` with status `'failed'`.

### 2.4 Worker Idempotency & Concurrency Configuration
- Update worker `email_logs` INSERT to use `ON CONFLICT (campaign_id, recipient_id) WHERE status = 'sent' DO NOTHING RETURNING id`.
- If no row returned, another worker completed the send — cleanly exit without sending.
- Expose `WORKER_CONCURRENCY` in config and worker process.

---

## 3. Implementation Checklist & Verification Gates

- [ ] **Step 1:** Migration `004_add_idempotency_and_sender_limit.sql`
- [ ] **Step 2:** Migration `005_add_schema_migrations.sql` & update `src/db/migrate.ts`
- [ ] **Step 3:** Symmetric credential encryption in `src/utils/crypto.ts` and `src/services/senderService.ts`
- [ ] **Step 4:** Remove Tier 3 synthetic delivery in `src/services/emailService.ts`
- [ ] **Step 5:** Idempotent database operations & concurrency configuration in `src/workers/emailWorker.ts`
- [ ] **Step 6:** Type synchronization in `src/types/db.types.ts`
- [ ] **Step 7:** Config & Environment updates in `src/config/index.ts` and `.env.example`
- [ ] **Step 8:** Verification tests & TypeScript compilation check
- [ ] **Step 9:** Update `docs/IMPLEMENTATION_LOG.md` and commit to `feat/database-foundation`
