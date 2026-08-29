-- =============================================================================
-- Migration: 002_add_senders
-- Description: Creates the senders table, links it to campaigns and email_logs,
--              and sets up appropriate constraints and indexes.
-- =============================================================================

-- =============================================================================
-- TABLE: senders
-- WHY: Holds SMTP configurations for multiple email senders.
-- =============================================================================
CREATE TABLE IF NOT EXISTS senders (
  id           UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID                     NOT NULL,
  name         VARCHAR                  NOT NULL,
  email        VARCHAR                  NOT NULL,
  smtp_host    VARCHAR                  NOT NULL,
  smtp_port    INTEGER                  NOT NULL,
  smtp_secure  BOOLEAN                  NOT NULL DEFAULT FALSE,
  smtp_user    VARCHAR                  NOT NULL,
  smtp_pass    VARCHAR                  NOT NULL,
  created_at   TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ              NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_senders_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,

  CONSTRAINT chk_smtp_port
    CHECK (smtp_port > 0 AND smtp_port <= 65535)
);

CREATE INDEX IF NOT EXISTS idx_senders_user_id ON senders (user_id);

-- =============================================================================
-- ALTER TABLE: campaigns
-- WHY: Links campaigns to a specific sender configured by the user.
--      Must be nullable to preserve existing campaigns and tests.
--      ON DELETE RESTRICT prevents deleting a sender if referenced by campaigns.
-- =============================================================================
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sender_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_campaigns_sender' AND table_name = 'campaigns'
  ) THEN
    ALTER TABLE campaigns
      ADD CONSTRAINT fk_campaigns_sender
      FOREIGN KEY (sender_id) REFERENCES senders (id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_campaigns_sender_id ON campaigns (sender_id);

-- =============================================================================
-- ALTER TABLE: email_logs
-- WHY: Tracks which sender was historically used for sending an email.
--      Must be nullable. ON DELETE SET NULL ensures log history remains
--      intact if a sender is somehow deleted.
-- =============================================================================
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS sender_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_email_logs_sender' AND table_name = 'email_logs'
  ) THEN
    ALTER TABLE email_logs
      ADD CONSTRAINT fk_email_logs_sender
      FOREIGN KEY (sender_id) REFERENCES senders (id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_email_logs_sender_id ON email_logs (sender_id);
