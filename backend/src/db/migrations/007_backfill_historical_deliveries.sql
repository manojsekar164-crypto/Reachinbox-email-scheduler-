-- =============================================================================
-- Migration: 007_backfill_historical_deliveries
-- Description: Safely backfills existing recipients and email_logs into the
--              new email_deliveries and email_attempts models.
--
-- REVISION HIGHLIGHTS (ROUND 3):
--   - Unsafe "ELSE 'pending'" completely removed.
--   - Ambiguous historical logs (queued, processing, attempting, unknown) map
--     to non-dispatchable "unknown" delivery status.
--   - Definite send logs map to "sent" (clearing stale last_error even if prior failures exist).
--   - Definite failure logs without send logs map to "failed" (non-dispatchable).
--   - Historical "sending", "paused", or ambiguous campaigns without logs map to
--     "cancelled" (non-dispatchable hold).
--   - Scheduled campaigns require a valid future scheduled_at timestamp; expired timestamps map to "cancelled".
--   - Draft campaigns map to "pending" (unclaimable until explicit launch event).
--   - Deterministic tie-breaking on created_at + email_logs.id.
--   - Preserves sender_id and error_message; leaves unrecorded SMTP fields as NULL (no fabrication).
--   - Zero outbox replay events generated.
-- =============================================================================

-- Step 1: Backfill email_deliveries from recipients + campaigns + email_logs
INSERT INTO email_deliveries (
  campaign_id,
  recipient_id,
  sender_id,
  idempotency_key,
  status,
  scheduled_at,
  sent_at,
  attempt_count,
  last_error,
  created_at,
  updated_at
)
SELECT
  r.campaign_id,
  r.id AS recipient_id,
  COALESCE(sent_log.sender_id, latest_log.sender_id, c.sender_id) AS sender_id,
  'campaign_' || r.campaign_id || '_' || r.id AS idempotency_key,
  CASE
    -- 1. Definite successful send log exists -> sent (permanent terminal state)
    WHEN sent_log.id IS NOT NULL THEN 'sent'

    -- 2. Ambiguous in-flight/unknown log exists and no confirmed send -> unknown (non-dispatchable)
    -- Never blindly retry an email whose SMTP outcome is uncertain
    WHEN ambiguous_log.id IS NOT NULL THEN 'unknown'

    -- 3. Definite failure log exists without send log -> failed (non-dispatchable)
    WHEN failed_log.id IS NOT NULL THEN 'failed'

    -- 4. Completed, sent, failed, or terminated campaigns without logs -> cancelled (never re-dispatched)
    WHEN c.status IN ('completed', 'sent', 'failed', 'terminated') THEN 'cancelled'

    -- 5. Ambiguous pre-upgrade active states -> cancelled (safe non-dispatchable hold)
    WHEN c.status IN ('sending', 'paused') THEN 'cancelled'

    -- 6. Scheduled campaigns: only future timestamps remain scheduled
    WHEN c.status = 'scheduled' AND c.scheduled_at IS NOT NULL AND c.scheduled_at > NOW() THEN 'scheduled'
    WHEN c.status = 'scheduled' THEN 'cancelled' -- expired scheduled time becomes cancelled

    -- 7. Draft campaigns -> pending (unclaimable until explicit operator launch)
    WHEN c.status = 'draft' THEN 'pending'

    -- 8. All other states default to safe non-dispatchable cancelled
    ELSE 'cancelled'
  END AS status,
  c.scheduled_at,
  sent_log.sent_at,
  COALESCE(log_counts.total_attempts, 0) AS attempt_count,
  CASE
    WHEN sent_log.id IS NOT NULL THEN NULL -- Clear stale failure details if delivered
    WHEN ambiguous_log.id IS NOT NULL THEN COALESCE(ambiguous_log.error_message, 'Ambiguous historical log status: ' || ambiguous_log.status)
    ELSE failed_log.error_message
  END AS last_error,
  r.created_at,
  NOW() AS updated_at
FROM recipients r
JOIN campaigns c ON c.id = r.campaign_id

-- Lateral join for latest successful send log
LEFT JOIN LATERAL (
  SELECT el.id, el.sender_id, el.sent_at
  FROM email_logs el
  WHERE el.campaign_id = r.campaign_id
    AND el.recipient_id = r.id
    AND el.status = 'sent'
  ORDER BY el.sent_at DESC NULLS LAST, el.id ASC
  LIMIT 1
) sent_log ON true

-- Lateral join for latest failure log
LEFT JOIN LATERAL (
  SELECT el.id, el.sender_id, el.error_message
  FROM email_logs el
  WHERE el.campaign_id = r.campaign_id
    AND el.recipient_id = r.id
    AND el.status = 'failed'
  ORDER BY el.created_at DESC, el.id ASC
  LIMIT 1
) failed_log ON true

-- Lateral join for ambiguous / in-flight / unknown logs
LEFT JOIN LATERAL (
  SELECT el.id, el.sender_id, el.status, el.error_message
  FROM email_logs el
  WHERE el.campaign_id = r.campaign_id
    AND el.recipient_id = r.id
    AND el.status NOT IN ('sent', 'failed')
  ORDER BY el.created_at DESC, el.id ASC
  LIMIT 1
) ambiguous_log ON true

-- Lateral join for most recent log sender
LEFT JOIN LATERAL (
  SELECT el.sender_id
  FROM email_logs el
  WHERE el.campaign_id = r.campaign_id
    AND el.recipient_id = r.id
  ORDER BY el.created_at DESC, el.id ASC
  LIMIT 1
) latest_log ON true

-- Aggregate attempt counts
LEFT JOIN (
  SELECT campaign_id, recipient_id, COUNT(*) AS total_attempts
  FROM email_logs
  GROUP BY campaign_id, recipient_id
) log_counts ON log_counts.campaign_id = r.campaign_id AND log_counts.recipient_id = r.id

ON CONFLICT (campaign_id, recipient_id) DO NOTHING;

-- Step 2: Backfill email_attempts from historical email_logs
-- Uses created_at + id tie-breaker for deterministic attempt ordering.
-- Preserves both duplicate historical logs as distinct attempt entries.
-- Leaves unavailable SMTP metadata as NULL (no fabrication).
INSERT INTO email_attempts (
  id,
  delivery_id,
  attempt_number,
  status,
  sender_id,
  error_message,
  attempted_at,
  completed_at
)
SELECT
  el.id,
  ed.id AS delivery_id,
  ROW_NUMBER() OVER (
    PARTITION BY ed.id
    ORDER BY el.created_at ASC, el.id ASC
  ) AS attempt_number,
  CASE
    WHEN el.status = 'sent' THEN 'sent'
    WHEN el.status = 'failed' THEN 'failed'
    WHEN el.status IN ('attempting', 'processing', 'in_progress') THEN 'attempting'
    WHEN el.status = 'rate_limited' THEN 'rate_limited'
    ELSE 'unknown'
  END AS status,
  el.sender_id,
  el.error_message,
  el.created_at AS attempted_at,
  el.sent_at AS completed_at
FROM email_logs el
JOIN email_deliveries ed
  ON ed.campaign_id = el.campaign_id AND ed.recipient_id = el.recipient_id
ON CONFLICT (delivery_id, attempt_number) DO NOTHING;
