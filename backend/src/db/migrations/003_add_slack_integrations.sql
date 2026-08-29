-- =============================================================================
-- Migration: 003_add_slack_integrations
-- Description: Creates the slack_integrations table to store OAuth connections.
-- Safe to re-run: all statements use IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS slack_integrations (
  id           UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID                     NOT NULL UNIQUE,
  team_id      VARCHAR                  NOT NULL,
  team_name    VARCHAR                  NOT NULL,
  access_token VARCHAR                  NOT NULL,
  channel_id   VARCHAR,
  channel_name VARCHAR,
  webhook_url  VARCHAR,
  scope        VARCHAR                  NOT NULL,
  created_at   TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ              NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_slack_integrations_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_slack_integrations_user_id ON slack_integrations (user_id);
