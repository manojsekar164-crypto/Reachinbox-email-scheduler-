-- =============================================================================
-- Migration: 006_create_delivery_and_outbox_schema
-- Description: Creates the durable email delivery model, attempt history,
--              transactional outbox schema, and migration tracking enhancement.
--
-- REVISION HIGHLIGHTS (ROUND 2):
--  - Replaced CASCADE deletions with RESTRICT to guarantee attempt and delivery
--    history cannot disappear when campaigns or recipients are deleted.
--  - Added composite relational integrity check between delivery and recipient/campaign.
--  - Added claim_owner, claimed_at, and lease_expires_at to delivery_outbox for
--    distributed recovery without race conditions.
--  - Added deleted_at to email_deliveries for safe soft-delete support.
-- =============================================================================

-- Enable pgcrypto if not already enabled (for gen_random_uuid())
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. TABLE: schema_migrations (Enhancement)
-- =============================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    VARCHAR      PRIMARY KEY,
  checksum    VARCHAR(64)  NOT NULL DEFAULT '',
  applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum VARCHAR(64) NOT NULL DEFAULT '';

-- =============================================================================
-- 2. RELATIONAL INTEGRITY: Composite index on recipients (id, campaign_id)
-- WHY: Guarantees email_deliveries cannot link a recipient to the wrong campaign.
-- =============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_recipients_id_campaign
  ON recipients (id, campaign_id);

-- =============================================================================
-- 3. TABLE: email_deliveries
-- WHY: Canonical delivery model representing individual recipient dispatches.
--      Uses RESTRICT on foreign keys to prevent accidental loss of historical records.
-- =============================================================================
CREATE TABLE IF NOT EXISTS email_deliveries (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       UUID         NOT NULL,
  recipient_id      UUID         NOT NULL,
  sender_id         UUID,
  idempotency_key   VARCHAR      NOT NULL,
  status            VARCHAR      NOT NULL DEFAULT 'pending',
  scheduled_at      TIMESTAMPTZ,
  sent_at           TIMESTAMPTZ,
  smtp_message_id   VARCHAR,
  attempt_count     INTEGER      NOT NULL DEFAULT 0,
  last_error        TEXT,
  next_attempt_at   TIMESTAMPTZ,
  claim_owner       VARCHAR,
  claimed_at        TIMESTAMPTZ,
  lease_expires_at  TIMESTAMPTZ,
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_email_deliveries_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE RESTRICT,

  CONSTRAINT fk_email_deliveries_recipient
    FOREIGN KEY (recipient_id) REFERENCES recipients (id) ON DELETE RESTRICT,

  CONSTRAINT fk_email_deliveries_recipient_campaign
    FOREIGN KEY (recipient_id, campaign_id) REFERENCES recipients (id, campaign_id) ON DELETE RESTRICT,

  CONSTRAINT fk_email_deliveries_sender
    FOREIGN KEY (sender_id) REFERENCES senders (id) ON DELETE SET NULL,

  CONSTRAINT uq_email_deliveries_campaign_recipient
    UNIQUE (campaign_id, recipient_id),

  CONSTRAINT uq_email_deliveries_idempotency_key
    UNIQUE (idempotency_key),

  CONSTRAINT chk_email_deliveries_attempt_count
    CHECK (attempt_count >= 0),

  CONSTRAINT chk_email_deliveries_status
    CHECK (status IN (
      'pending',
      'scheduled',
      'sending',
      'retry_wait',
      'sent',
      'failed',
      'unknown',
      'cancelled'
    ))
);

CREATE INDEX IF NOT EXISTS idx_email_deliveries_campaign_id    ON email_deliveries (campaign_id);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_recipient_id   ON email_deliveries (recipient_id);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_sender_id      ON email_deliveries (sender_id);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_status         ON email_deliveries (status);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_scheduled_at   ON email_deliveries (scheduled_at);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_next_attempt   ON email_deliveries (next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_claim          ON email_deliveries (claim_owner, lease_expires_at);

-- =============================================================================
-- 4. TABLE: email_attempts
-- WHY: Immutable attempt-by-attempt audit log. Uses RESTRICT to protect audit history.
-- =============================================================================
CREATE TABLE IF NOT EXISTS email_attempts (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id           UUID         NOT NULL,
  attempt_number        INTEGER      NOT NULL,
  status                VARCHAR      NOT NULL,
  sender_id             UUID,
  smtp_response_code    VARCHAR,
  smtp_message_id       VARCHAR,
  error_classification  VARCHAR,
  error_message         TEXT,
  attempted_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,

  CONSTRAINT fk_email_attempts_delivery
    FOREIGN KEY (delivery_id) REFERENCES email_deliveries (id) ON DELETE RESTRICT,

  CONSTRAINT fk_email_attempts_sender
    FOREIGN KEY (sender_id) REFERENCES senders (id) ON DELETE SET NULL,

  CONSTRAINT uq_email_attempts_delivery_number
    UNIQUE (delivery_id, attempt_number),

  CONSTRAINT chk_email_attempts_number
    CHECK (attempt_number >= 1),

  CONSTRAINT chk_email_attempts_status
    CHECK (status IN ('attempting', 'sent', 'failed', 'unknown', 'rate_limited'))
);

CREATE INDEX IF NOT EXISTS idx_email_attempts_delivery_id  ON email_attempts (delivery_id);
CREATE INDEX IF NOT EXISTS idx_email_attempts_sender_id    ON email_attempts (sender_id);
CREATE INDEX IF NOT EXISTS idx_email_attempts_status       ON email_attempts (status);
CREATE INDEX IF NOT EXISTS idx_email_attempts_attempted_at ON email_attempts (attempted_at);

-- =============================================================================
-- 5. TABLE: delivery_outbox
-- WHY: Transactional outbox with claim ownership and lease expiration for
--      distributed crash recovery and safe multi-worker dispatching.
-- =============================================================================
CREATE TABLE IF NOT EXISTS delivery_outbox (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type         VARCHAR      NOT NULL,
  aggregate_id       UUID         NOT NULL,
  deduplication_key  VARCHAR      NOT NULL,
  payload            JSONB        NOT NULL,
  status             VARCHAR      NOT NULL DEFAULT 'pending',
  attempt_count      INTEGER      NOT NULL DEFAULT 0,
  claim_owner        VARCHAR,
  claimed_at         TIMESTAMPTZ,
  lease_expires_at   TIMESTAMPTZ,
  available_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  dispatched_at      TIMESTAMPTZ,
  last_error         TEXT,

  CONSTRAINT uq_delivery_outbox_dedup
    UNIQUE (deduplication_key),

  CONSTRAINT chk_delivery_outbox_attempt_count
    CHECK (attempt_count >= 0),

  CONSTRAINT chk_delivery_outbox_status
    CHECK (status IN ('pending', 'processing', 'dispatched', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_delivery_outbox_claim        ON delivery_outbox (status, available_at, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_delivery_outbox_aggregate_id ON delivery_outbox (aggregate_id);
