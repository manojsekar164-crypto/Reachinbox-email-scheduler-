-- =============================================================================
-- Migration: 005_backfill_historical_deliveries
-- Description: Safely backfills existing recipients and email_logs into the
--              new email_deliveries and email_attempts models.
--
-- Historical Status Mapping:
--   1. Recipient with a 'sent' log:
--      -> status = 'sent', sent_at = log.sent_at
--   2. Recipient with 'failed' log (no 'sent' log):
--      -> status = 'failed', last_error = log.error_message (NOT sendable)
--   3. Recipient without logs:
--      - Parent campaign status 'scheduled' -> status = 'scheduled'
--      - Parent campaign status 'draft'     -> status = 'pending'
--      - Parent campaign status completed/terminated -> status = 'cancelled'
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
  COALESCE(latest_log.sender_id, c.sender_id) AS sender_id,
  'campaign_' || r.campaign_id || '_recipient_' || r.id AS idempotency_key,
  CASE
    WHEN sent_log.id IS NOT NULL THEN 'sent'
    WHEN failed_log.id IS NOT NULL THEN 'failed'
    WHEN c.status = 'scheduled' THEN 'scheduled'
    WHEN c.status = 'draft' THEN 'pending'
    WHEN c.status IN ('completed', 'sent', 'failed') THEN 'cancelled'
    ELSE 'pending'
  END AS status,
  c.scheduled_at,
  sent_log.sent_at,
  COALESCE(log_counts.total_attempts, 0) AS attempt_count,
  failed_log.error_message AS last_error,
  r.created_at,
  NOW() AS updated_at
FROM recipients r
JOIN campaigns c ON c.id = r.campaign_id
-- Check for any successful send
LEFT JOIN LATERAL (
  SELECT el.id, el.sender_id, el.sent_at
  FROM email_logs el
  WHERE el.campaign_id = r.campaign_id
    AND el.recipient_id = r.id
    AND el.status = 'sent'
  ORDER BY el.sent_at DESC NULLS LAST
  LIMIT 1
) sent_log ON true
-- Check for latest failure
LEFT JOIN LATERAL (
  SELECT el.id, el.sender_id, el.error_message
  FROM email_logs el
  WHERE el.campaign_id = r.campaign_id
    AND el.recipient_id = r.id
    AND el.status = 'failed'
  ORDER BY el.created_at DESC
  LIMIT 1
) failed_log ON true
-- Most recent log for sender metadata
LEFT JOIN LATERAL (
  SELECT el.sender_id
  FROM email_logs el
  WHERE el.campaign_id = r.campaign_id
    AND el.recipient_id = r.id
  ORDER BY el.created_at DESC
  LIMIT 1
) latest_log ON true
-- Attempt counts
LEFT JOIN (
  SELECT campaign_id, recipient_id, COUNT(*) AS total_attempts
  FROM email_logs
  GROUP BY campaign_id, recipient_id
) log_counts ON log_counts.campaign_id = r.campaign_id AND log_counts.recipient_id = r.id
ON CONFLICT (campaign_id, recipient_id) DO NOTHING;

-- Step 2: Backfill email_attempts from historical email_logs
INSERT INTO email_attempts (
  id,
  delivery_id,
  attempt_number,
  status,
  error_message,
  attempted_at,
  completed_at
)
SELECT
  el.id,
  ed.id AS delivery_id,
  ROW_NUMBER() OVER (PARTITION BY ed.id ORDER BY el.created_at ASC) AS attempt_number,
  CASE
    WHEN el.status = 'sent' THEN 'sent'
    WHEN el.status = 'failed' THEN 'failed'
    ELSE 'unknown'
  END AS status,
  el.error_message,
  el.created_at AS attempted_at,
  el.sent_at AS completed_at
FROM email_logs el
JOIN email_deliveries ed
  ON ed.campaign_id = el.campaign_id AND ed.recipient_id = el.recipient_id
ON CONFLICT (delivery_id, attempt_number) DO NOTHING;
