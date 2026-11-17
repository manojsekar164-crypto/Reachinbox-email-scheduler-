-- =============================================================================
-- Migration: 004_add_idempotency_and_sender_limit
-- Description: Adds sender hourly_limit and non-unique index on email_logs.
--
-- HISTORICAL DUPLICATE SAFETY GUARANTEE:
-- A unique index is NOT created on historical email_logs because existing
-- production data contains duplicate sent records for the same (campaign_id, recipient_id).
-- Imposing a unique index on email_logs would cause migration failure or force
-- destructive deduplication. Instead, canonical idempotency is enforced by the
-- email_deliveries table (Migration 006) via uq_email_deliveries_campaign_recipient.
-- =============================================================================

-- 1. Performance index for log lookup (non-unique to preserve historical duplicates)
CREATE INDEX IF NOT EXISTS idx_email_logs_campaign_recipient
  ON email_logs (campaign_id, recipient_id);

-- 2. Sender-Level Rate Limiting
-- Adds hourly_limit column to senders table with a default of 100 emails/hour.
ALTER TABLE senders ADD COLUMN IF NOT EXISTS hourly_limit INTEGER NOT NULL DEFAULT 100;
