-- =============================================================================
-- Migration: 004_add_idempotency_and_sender_limit
-- Description: Adds a partial unique index on email_logs to enforce delivery
--              idempotency at the database level, and adds hourly_limit to senders.
-- =============================================================================

-- 1. Idempotency Partial Unique Index
-- Guarantees that for any campaign_id and recipient_id, there can NEVER be more
-- than one row where status = 'sent'. Prevents double delivery under concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_logs_idempotency
  ON email_logs (campaign_id, recipient_id)
  WHERE status = 'sent';

-- 2. Sender-Level Rate Limiting
-- Adds hourly_limit column to senders table with a default of 100 emails/hour.
ALTER TABLE senders ADD COLUMN IF NOT EXISTS hourly_limit INTEGER NOT NULL DEFAULT 100;
