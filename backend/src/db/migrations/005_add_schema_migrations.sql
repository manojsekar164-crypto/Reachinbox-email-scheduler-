-- =============================================================================
-- Migration: 005_add_schema_migrations
-- Description: Creates the schema_migrations table to track applied migrations.
-- =============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   VARCHAR      PRIMARY KEY,
  applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
