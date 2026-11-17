-- =============================================================================
-- Migration: 006_create_delivery_and_outbox_schema
-- Description: Creates the durable email delivery model, attempt history,
--              transactional outbox schema, and migration tracking table.
-- =============================================================================

-- Enable pgcrypto if not already enabled
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- TABLE: schema_migrations
-- WHY: Tracks applied migration files with SHA-256 checksums to ensure
--      deterministic, immutable, and safe forward-only schema migrations.
-- =============================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    VARCHAR      PRIMARY KEY,
  checksum    VARCHAR(64)  NOT NULL DEFAULT '',
  applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum VARCHAR(64) NOT NULL DEFAULT '';

-- =============================================================================
-- ALTER TABLE: senders
-- WHY: Supports shared sender-level rate limiting across campaigns.
-- =============================================================================
ALTER TABLE senders ADD COLUMN IF NOT EXISTS hourly_limit INTEGER NOT NULL DEFAULT 100;

-- =============================================================================
-- PARTIAL UNIQUE INDEX: email_logs
-- WHY: Database-level idempotency guarantee preventing duplicate sent records.
-- =============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_logs_idempotency
  ON email_logs (campaign_id, recipient_id)
  WHERE status = 'sent';

-- =============================================================================
-- TABLE: email_deliveries
-- WHY: Canonical delivery model representing individual recipient dispatches.
--      Stores persistent scheduling, leasing, attempt counters, and state.
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
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_email_deliveries_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE,

  CONSTRAINT fk_email_deliveries_recipient
    FOREIGN KEY (recipient_id) REFERENCES recipients (id) ON DELETE CASCADE,

  CONSTRAINT fk_email_deliveries_sender
    FOREIGN KEY (sender_id) REFERENCES senders (id) ON DELETE SET NULL,

  CONSTRAINT uq_email_deliveries_campaign_recipient
    UNIQUE (campaign_id, recipient_id),

  CONSTRAINT uq_email_deliveries_idempotency_key
    UNIQUE (idempotency_key),

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
-- TABLE: email_attempts
-- WHY: Immutable attempt-by-attempt dispatch audit log for every delivery.
-- =============================================================================
CREATE TABLE IF NOT EXISTS email_attempts (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id           UUID         NOT NULL,
  attempt_number        INTEGER      NOT NULL,
  status                VARCHAR      NOT NULL,
  smtp_response_code    VARCHAR,
  smtp_message_id       VARCHAR,
  error_classification  VARCHAR,
  error_message         TEXT,
  attempted_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,

  CONSTRAINT fk_email_attempts_delivery
    FOREIGN KEY (delivery_id) REFERENCES email_deliveries (id) ON DELETE CASCADE,

  CONSTRAINT uq_email_attempts_delivery_number
    UNIQUE (delivery_id, attempt_number),

  CONSTRAINT chk_email_attempts_status
    CHECK (status IN ('attempting', 'sent', 'failed', 'unknown', 'rate_limited'))
);

CREATE INDEX IF NOT EXISTS idx_email_attempts_delivery_id  ON email_attempts (delivery_id);
CREATE INDEX IF NOT EXISTS idx_email_attempts_status       ON email_attempts (status);
CREATE INDEX IF NOT EXISTS idx_email_attempts_attempted_at ON email_attempts (attempted_at);

-- =============================================================================
-- TABLE: delivery_outbox
-- WHY: Transactional outbox schema allowing atomic creation of delivery and
--      publishing intent in the same PostgreSQL transaction.
-- =============================================================================
CREATE TABLE IF NOT EXISTS delivery_outbox (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type         VARCHAR      NOT NULL,
  aggregate_id       UUID         NOT NULL,
  deduplication_key  VARCHAR      NOT NULL,
  payload            JSONB        NOT NULL,
  status             VARCHAR      NOT NULL DEFAULT 'pending',
  attempt_count      INTEGER      NOT NULL DEFAULT 0,
  available_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  dispatched_at      TIMESTAMPTZ,
  last_error         TEXT,

  CONSTRAINT uq_delivery_outbox_dedup
    UNIQUE (deduplication_key),

  CONSTRAINT chk_delivery_outbox_status
    CHECK (status IN ('pending', 'processing', 'dispatched', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_delivery_outbox_status_avail ON delivery_outbox (status, available_at);
CREATE INDEX IF NOT EXISTS idx_delivery_outbox_aggregate_id ON delivery_outbox (aggregate_id);
