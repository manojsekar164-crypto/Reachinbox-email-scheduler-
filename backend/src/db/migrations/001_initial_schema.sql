-- =============================================================================
-- Migration: 001_initial_schema
-- Description: Creates the four core tables for the ReachInbox email scheduler.
-- Safe to re-run: all statements use IF NOT EXISTS where possible.
-- =============================================================================

-- Enable pgcrypto so we can use gen_random_uuid() for UUID primary keys.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- TABLE: users
-- WHY: Every campaign belongs to a user. We need a central identity record
--      so that future auth (Google OAuth) can attach to it without changing
--      the rest of the schema.
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
  id          UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id   VARCHAR,
  email       VARCHAR        NOT NULL UNIQUE,
  name        VARCHAR,
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- NOTE: No separate index on users.email is needed.
-- The UNIQUE constraint above already creates a unique B-tree index on that column.

-- =============================================================================
-- TABLE: campaigns
-- WHY: A campaign groups a subject/body that gets sent to many recipients.
--      It belongs to a user and controls scheduling + hourly send rate.
-- =============================================================================
CREATE TABLE IF NOT EXISTS campaigns (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID         NOT NULL,
  subject       VARCHAR      NOT NULL,
  body          TEXT         NOT NULL,
  scheduled_at  TIMESTAMPTZ,
  hourly_limit  INTEGER      NOT NULL DEFAULT 5,
  status        VARCHAR      NOT NULL DEFAULT 'draft',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_campaigns_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_campaigns_user_id      ON campaigns (user_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status       ON campaigns (status);
CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled_at ON campaigns (scheduled_at);

-- =============================================================================
-- TABLE: recipients
-- WHY: A campaign can target many email addresses. Each row tracks whether
--      that individual address has been sent to yet (status field).
-- =============================================================================
CREATE TABLE IF NOT EXISTS recipients (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID         NOT NULL,
  email        VARCHAR      NOT NULL,
  name         VARCHAR,
  status       VARCHAR      NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_recipients_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recipients_campaign_id ON recipients (campaign_id);
CREATE INDEX IF NOT EXISTS idx_recipients_status      ON recipients (status);

-- =============================================================================
-- TABLE: email_logs
-- WHY: Audit trail for every send attempt. Records whether an email was
--      delivered, failed, or bounced, along with any error message.
-- =============================================================================
CREATE TABLE IF NOT EXISTS email_logs (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    UUID         NOT NULL,
  recipient_id   UUID         NOT NULL,
  status         VARCHAR      NOT NULL,
  sent_at        TIMESTAMPTZ,
  error_message  TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_email_logs_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE,

  CONSTRAINT fk_email_logs_recipient
    FOREIGN KEY (recipient_id) REFERENCES recipients (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_logs_campaign_id  ON email_logs (campaign_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_recipient_id ON email_logs (recipient_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_status       ON email_logs (status);
