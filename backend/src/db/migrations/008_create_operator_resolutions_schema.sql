-- =============================================================================
-- Migration: 008_create_operator_resolutions_schema
-- Description: Creates the operator resolutions audit table for tracking
--              operator review decisions on ambiguous/unknown email deliveries.
--
-- REVISION HIGHLIGHTS:
--   - Stores immutable audit records of operator decisions (confirmed_accepted,
--     confirmed_not_accepted) with mandatory reasons and user ownership.
--   - Uses RESTRICT on delivery_id foreign key to preserve audit history.
--   - Safe forward-only migration.
-- =============================================================================

CREATE TABLE IF NOT EXISTS delivery_resolutions (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id      UUID         NOT NULL,
  user_id          UUID         NOT NULL,
  decision         VARCHAR      NOT NULL,
  reason           TEXT         NOT NULL,
  previous_status  VARCHAR      NOT NULL,
  new_status       VARCHAR      NOT NULL,
  metadata         JSONB,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_delivery_resolutions_delivery
    FOREIGN KEY (delivery_id) REFERENCES email_deliveries (id) ON DELETE RESTRICT,

  CONSTRAINT fk_delivery_resolutions_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,

  CONSTRAINT chk_delivery_resolutions_decision
    CHECK (decision IN ('confirmed_accepted', 'confirmed_not_accepted'))
);

CREATE INDEX IF NOT EXISTS idx_delivery_resolutions_delivery_id ON delivery_resolutions (delivery_id);
CREATE INDEX IF NOT EXISTS idx_delivery_resolutions_user_id     ON delivery_resolutions (user_id);
CREATE INDEX IF NOT EXISTS idx_delivery_resolutions_created_at  ON delivery_resolutions (created_at);
