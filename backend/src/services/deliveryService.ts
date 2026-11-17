/**
 * src/services/deliveryService.ts
 *
 * Delivery Lifecycle & Atomic Claiming Service.
 *
 * Manages the canonical delivery state in `email_deliveries` and immutable audit
 * log in `email_attempts`. Implements PostgreSQL atomic delivery claiming using
 * `FOR UPDATE SKIP LOCKED` and `UPDATE ... RETURNING`.
 */

import { Pool, PoolClient } from 'pg';
import { db as defaultPool } from '../db/postgres';
import { EmailDeliveryRow, DeliveryStatus } from '../types/db.types';
import {
  classifySmtpOutcome,
  isUncertainSmtpError,
  SmtpOutcomeCategory,
  SmtpClassificationResult,
} from './smtpClassifier';

export {
  classifySmtpOutcome,
  isUncertainSmtpError,
  SmtpOutcomeCategory,
  SmtpClassificationResult,
};

export interface ClaimDeliveryOptions {
  campaignId: string;
  recipientId: string;
  claimOwner: string;
  leaseDurationMs?: number;
  dbClient?: Pool | PoolClient;
}

export interface EnsureDeliveryOptions {
  campaignId: string;
  recipientId: string;
  senderId?: string | null;
  scheduledAt?: Date | null;
  dbClient?: Pool | PoolClient;
}

export interface UncertainErrorCheck {
  message?: string;
  code?: string;
  isUncertain?: boolean;
}

/**
 * Atomically activates a due scheduled campaign:
 * Transitions campaign status from 'scheduled' to 'sending' IF AND ONLY IF
 * (scheduled_at IS NULL OR scheduled_at <= NOW()).
 * Idempotent: If already 'sending' or 'completed', returns false gracefully.
 */
export async function activateDueCampaign(
  campaignId: string,
  client: Pool | PoolClient = defaultPool
): Promise<boolean> {
  const result = await client.query(
    `UPDATE campaigns
     SET status = 'sending',
         updated_at = NOW()
     WHERE id = $1
       AND status = 'scheduled'
       AND (scheduled_at IS NULL OR scheduled_at <= NOW())
     RETURNING id`,
    [campaignId]
  );
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Activates all scheduled campaigns that have reached their scheduled_at timestamp.
 */
export async function activateAllDueCampaigns(
  client: Pool | PoolClient = defaultPool
): Promise<number> {
  const result = await client.query(
    `UPDATE campaigns
     SET status = 'sending',
         updated_at = NOW()
     WHERE status = 'scheduled'
       AND scheduled_at IS NOT NULL
       AND scheduled_at <= NOW()
     RETURNING id`
  );
  return result.rowCount ?? 0;
}

/**
 * Retrieves the canonical delivery record by campaign and recipient.
 */
export async function getDelivery(
  campaignId: string,
  recipientId: string,
  client: Pool | PoolClient = defaultPool
): Promise<EmailDeliveryRow | null> {
  const result = await client.query<EmailDeliveryRow>(
    `SELECT * FROM email_deliveries WHERE campaign_id = $1 AND recipient_id = $2 LIMIT 1`,
    [campaignId, recipientId]
  );
  return result.rows[0] || null;
}

/**
 * Ensures an email_deliveries record exists for a campaign and recipient.
 * Creates it with status 'pending' if it does not exist yet.
 */
export async function ensureDeliveryRecord(
  options: EnsureDeliveryOptions,
  client: Pool | PoolClient = defaultPool
): Promise<EmailDeliveryRow> {
  const { campaignId, recipientId, senderId, scheduledAt } = options;
  const idempotencyKey = `campaign_${campaignId}_${recipientId}`;

  const result = await client.query<EmailDeliveryRow>(
    `INSERT INTO email_deliveries (
       campaign_id,
       recipient_id,
       sender_id,
       idempotency_key,
       status,
       scheduled_at,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, 'pending', $5, NOW(), NOW())
     ON CONFLICT (campaign_id, recipient_id) DO UPDATE
       SET updated_at = email_deliveries.updated_at
     RETURNING *`,
    [campaignId, recipientId, senderId || null, idempotencyKey, scheduledAt || null]
  );

  return result.rows[0];
}

/**
 * Atomically claims an email delivery for sending using `FOR UPDATE SKIP LOCKED`.
 *
 * Invariants:
 *  1. Checks campaign status = 'sending' (campaign eligibility).
 *  2. Excludes soft-deleted deliveries (deleted_at IS NULL).
 *  3. Excludes already sent, failed, or uncertain (unknown) deliveries.
 *  4. Atomically updates status to 'sending', records claim_owner, claimed_at,
 *     lease_expires_at, and increments attempt_count.
 *  5. If multiple workers concurrently attempt to claim the exact same delivery,
 *     exactly one worker acquires the row; the second worker skips it and receives null.
 */
export async function claimDelivery(
  options: ClaimDeliveryOptions
): Promise<EmailDeliveryRow | null> {
  const {
    campaignId,
    recipientId,
    claimOwner,
    leaseDurationMs = 60000,
    dbClient = defaultPool,
  } = options;

  const query = `
    WITH claimable AS (
      SELECT ed.id
      FROM email_deliveries ed
      JOIN campaigns c ON c.id = ed.campaign_id
      WHERE ed.campaign_id = $1
        AND ed.recipient_id = $2
        AND ed.deleted_at IS NULL
        AND c.status = 'sending'
        AND (
          ed.status = 'pending'
          OR (ed.status = 'retry_wait' AND (ed.next_attempt_at IS NULL OR ed.next_attempt_at <= NOW()))
          OR (ed.status = 'scheduled' AND (ed.scheduled_at IS NULL OR ed.scheduled_at <= NOW()))
          OR (ed.status = 'sending' AND ed.lease_expires_at IS NOT NULL AND ed.lease_expires_at < NOW())
        )
      FOR UPDATE OF ed SKIP LOCKED
      LIMIT 1
    )
    UPDATE email_deliveries ed
    SET status = 'sending',
        claim_owner = $3,
        claimed_at = NOW(),
        lease_expires_at = NOW() + ($4 || ' milliseconds')::INTERVAL,
        attempt_count = ed.attempt_count + 1,
        updated_at = NOW()
    FROM claimable
    WHERE ed.id = claimable.id
    RETURNING ed.*;
  `;

  const result = await dbClient.query<EmailDeliveryRow>(query, [
    campaignId,
    recipientId,
    claimOwner,
    leaseDurationMs,
  ]);

  return result.rows[0] || null;
}

/**
 * Releases a claim back to pending or retry_wait (e.g. when delayed by rate-limiting or send-spacing).
 * Resets the attempt_count increment since no send was actually attempted.
 */
export async function releaseDeliveryClaim(
  deliveryId: string,
  targetStatus: DeliveryStatus = 'pending',
  delayMs = 0,
  client: Pool | PoolClient = defaultPool
): Promise<void> {
  await client.query(
    `UPDATE email_deliveries
     SET status = $2,
         claim_owner = NULL,
         claimed_at = NULL,
         lease_expires_at = NULL,
         next_attempt_at = CASE WHEN $3::INTEGER > 0 THEN NOW() + ($3 || ' milliseconds')::INTERVAL ELSE NULL END,
         attempt_count = GREATEST(0, attempt_count - 1),
         updated_at = NOW()
     WHERE id = $1`,
    [deliveryId, targetStatus, delayMs]
  );
}

/**
 * Records the initiation of an email attempt in `email_attempts`.
 */
export async function recordAttemptStart(
  deliveryId: string,
  attemptNumber: number,
  senderId: string | null,
  client: Pool | PoolClient = defaultPool
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO email_attempts (
       delivery_id,
       attempt_number,
       status,
       sender_id,
       attempted_at
     )
     VALUES ($1, $2, 'attempting', $3, NOW())
     ON CONFLICT (delivery_id, attempt_number) DO UPDATE
       SET status = 'attempting', attempted_at = NOW()
     RETURNING id`,
    [deliveryId, attemptNumber, senderId]
  );
  return result.rows[0].id;
}

/**
 * Records a successful delivery outcome in `email_attempts` and marks the canonical delivery as 'sent'.
 * Stores genuine SMTP message ID and confirmed acceptance classification.
 */
export async function recordAttemptSuccess(
  deliveryId: string,
  attemptId: string | null,
  smtpMessageId: string | null,
  client: Pool | PoolClient = defaultPool,
  smtpResponseCode: string | null = null
): Promise<void> {
  const code = smtpResponseCode || null;

  // Update attempt history
  if (attemptId) {
    await client.query(
      `UPDATE email_attempts
       SET status = 'sent',
           smtp_message_id = $1,
           smtp_response_code = $2,
           error_classification = 'confirmed_acceptance',
           completed_at = NOW()
       WHERE id = $3`,
      [smtpMessageId, code, attemptId]
    );
  }

  // Update canonical delivery
  await client.query(
    `UPDATE email_deliveries
     SET status = 'sent',
         sent_at = NOW(),
         smtp_message_id = $1,
         last_error = NULL,
         claim_owner = NULL,
         lease_expires_at = NULL,
         next_attempt_at = NULL,
         updated_at = NOW()
     WHERE id = $2`,
    [smtpMessageId, deliveryId]
  );
}

/**
 * Records a database persistence failure occurring AFTER confirmed SMTP acceptance.
 * Invariant: Preserves the attempt record with genuine SMTP messageId, sets delivery to 'unknown'
 * (reconciliation required), clears lease and claim ownership, and ensures the delivery is NEVER
 * automatically retried or resent.
 */
export async function recordPostgresPersistenceFailure(
  deliveryId: string,
  attemptId: string | null,
  smtpMessageId: string | null,
  smtpResponseCode: string | null,
  dbErrorMessage: string,
  client: Pool | PoolClient = defaultPool
): Promise<void> {
  const code = smtpResponseCode || null;
  const desc = `PostgreSQL persistence failure after confirmed SMTP acceptance: ${dbErrorMessage}`;

  const tryUpdate = async (runner: Pool | PoolClient) => {
    if (attemptId) {
      await runner.query(
        `UPDATE email_attempts
         SET status = 'unknown',
             smtp_message_id = COALESCE($1, smtp_message_id),
             smtp_response_code = $2,
             error_classification = 'persistence_failure_after_acceptance',
             error_message = $3,
             completed_at = NOW()
         WHERE id = $4`,
        [smtpMessageId, code, desc, attemptId]
      );
    }

    await runner.query(
      `UPDATE email_deliveries
       SET status = 'unknown',
           smtp_message_id = COALESCE($1, smtp_message_id),
           last_error = $2,
           claim_owner = NULL,
           lease_expires_at = NULL,
           next_attempt_at = NULL,
           updated_at = NOW()
       WHERE id = $3`,
      [smtpMessageId, desc, deliveryId]
    );
  };

  try {
    await tryUpdate(client);
  } catch (err: any) {
    if (client !== defaultPool) {
      try {
        await tryUpdate(defaultPool);
      } catch (poolErr: any) {
        console.error(`💥 [Delivery ${deliveryId}] Failed to record persistence failure state:`, poolErr.message);
      }
    }
  }
}

/**
 * Records a permanent SMTP rejection in `email_attempts` and sets canonical delivery to terminal 'failed'.
 * Non-retryable: Prevents automated retry loops for 5xx errors or invalid credentials.
 */
export async function recordAttemptPermanentRejection(
  deliveryId: string,
  attemptId: string,
  error: { message?: string; responseCode?: string | null; errorDetail?: string },
  client: Pool | PoolClient = defaultPool
): Promise<void> {
  const code = error.responseCode || '5xx';
  const desc = error.errorDetail || error.message || 'Permanent SMTP rejection';

  await client.query(
    `UPDATE email_attempts
     SET status = 'failed',
         smtp_response_code = $1,
         error_classification = 'permanent_rejection',
         error_message = $2,
         completed_at = NOW()
     WHERE id = $3`,
    [code, desc, attemptId]
  );

  await client.query(
    `UPDATE email_deliveries
     SET status = 'failed',
         last_error = $1,
         claim_owner = NULL,
         lease_expires_at = NULL,
         next_attempt_at = NULL,
         updated_at = NOW()
     WHERE id = $2`,
    [desc, deliveryId]
  );
}

/**
 * Records a transient SMTP rejection in `email_attempts`.
 * Sets canonical delivery to 'retry_wait' if attempts remain, otherwise to 'failed'.
 */
export async function recordAttemptTransientRejection(
  deliveryId: string,
  attemptId: string,
  error: { message?: string; responseCode?: string | null; errorDetail?: string },
  attemptCount: number,
  maxAttempts = 3,
  retryDelayMs = 5000,
  client: Pool | PoolClient = defaultPool
): Promise<void> {
  const code = error.responseCode || '4xx';
  const desc = error.errorDetail || error.message || 'Transient SMTP rejection';
  const isFinal = attemptCount >= maxAttempts;
  const targetStatus: DeliveryStatus = isFinal ? 'failed' : 'retry_wait';

  await client.query(
    `UPDATE email_attempts
     SET status = 'failed',
         smtp_response_code = $1,
         error_classification = 'transient_rejection',
         error_message = $2,
         completed_at = NOW()
     WHERE id = $3`,
    [code, desc, attemptId]
  );

  const nextAttemptClause =
    targetStatus === 'retry_wait' && retryDelayMs > 0
      ? `NOW() + (${Number(retryDelayMs)} || ' milliseconds')::INTERVAL`
      : 'NULL';

  await client.query(
    `UPDATE email_deliveries
     SET status = $1,
         last_error = $2,
         claim_owner = NULL,
         lease_expires_at = NULL,
         next_attempt_at = ${nextAttemptClause},
         updated_at = NOW()
     WHERE id = $3`,
    [targetStatus, desc, deliveryId]
  );
}

/**
 * Records a connection failure confirmed before message acceptance in `email_attempts`.
 * Sets canonical delivery to 'retry_wait' if attempts remain, otherwise to 'failed'.
 */
export async function recordAttemptConnectionFailure(
  deliveryId: string,
  attemptId: string,
  error: { message?: string; responseCode?: string | null; errorDetail?: string },
  attemptCount: number,
  maxAttempts = 3,
  retryDelayMs = 5000,
  client: Pool | PoolClient = defaultPool
): Promise<void> {
  const code = error.responseCode || 'ECONNREFUSED';
  const desc = error.errorDetail || error.message || 'Connection failure before message acceptance';
  const isFinal = attemptCount >= maxAttempts;
  const targetStatus: DeliveryStatus = isFinal ? 'failed' : 'retry_wait';

  await client.query(
    `UPDATE email_attempts
     SET status = 'failed',
         smtp_response_code = $1,
         error_classification = 'connection_failure',
         error_message = $2,
         completed_at = NOW()
     WHERE id = $3`,
    [code, desc, attemptId]
  );

  const nextAttemptClause =
    targetStatus === 'retry_wait' && retryDelayMs > 0
      ? `NOW() + (${Number(retryDelayMs)} || ' milliseconds')::INTERVAL`
      : 'NULL';

  await client.query(
    `UPDATE email_deliveries
     SET status = $1,
         last_error = $2,
         claim_owner = NULL,
         lease_expires_at = NULL,
         next_attempt_at = ${nextAttemptClause},
         updated_at = NOW()
     WHERE id = $3`,
    [targetStatus, desc, deliveryId]
  );
}

/**
 * Records an ambiguous SMTP delivery outcome in `email_attempts` and marks the canonical delivery as 'unknown'.
 * Sets terminal non-dispatchable 'unknown' state without automatic retry.
 */
export async function recordAttemptAmbiguousOutcome(
  deliveryId: string,
  attemptId: string,
  error: { message?: string; responseCode?: string | null; errorDetail?: string },
  client: Pool | PoolClient = defaultPool
): Promise<void> {
  const code = error.responseCode || 'ETIMEDOUT';
  const desc = error.errorDetail
    ? `Uncertain SMTP delivery outcome: ${error.errorDetail}`
    : `Uncertain SMTP delivery outcome: ${error.message || 'Connection lost during or after DATA transmission'}`;

  // Update attempt history
  await client.query(
    `UPDATE email_attempts
     SET status = 'unknown',
         smtp_response_code = $1,
         error_classification = 'ambiguous_outcome',
         error_message = $2,
         completed_at = NOW()
     WHERE id = $3`,
    [code, desc, attemptId]
  );

  // Update canonical delivery to terminal 'unknown' (never retried)
  await client.query(
    `UPDATE email_deliveries
     SET status = 'unknown',
         last_error = $1,
         claim_owner = NULL,
         lease_expires_at = NULL,
         next_attempt_at = NULL,
         updated_at = NOW()
     WHERE id = $2`,
    [desc, deliveryId]
  );
}

/**
 * Backward-compatible helper for uncertain outcomes. Delegates to recordAttemptAmbiguousOutcome.
 */
export async function recordAttemptUncertain(
  deliveryId: string,
  attemptId: string,
  error: { message: string; code?: string },
  client: Pool | PoolClient = defaultPool
): Promise<void> {
  return recordAttemptAmbiguousOutcome(
    deliveryId,
    attemptId,
    { message: error.message, responseCode: error.code },
    client
  );
}

/**
 * Backward-compatible helper for definite failure. Classifies outcome and delegates accordingly.
 */
export async function recordAttemptFailure(
  deliveryId: string,
  attemptId: string,
  error: { message: string; code?: string },
  attemptCount: number,
  maxAttempts = 3,
  retryDelayMs = 5000,
  client: Pool | PoolClient = defaultPool
): Promise<void> {
  const classification = classifySmtpOutcome(error);
  if (classification.category === 'permanent_rejection') {
    return recordAttemptPermanentRejection(
      deliveryId,
      attemptId,
      { message: error.message, responseCode: classification.responseCode, errorDetail: classification.errorDetail },
      client
    );
  } else if (classification.category === 'transient_rejection') {
    return recordAttemptTransientRejection(
      deliveryId,
      attemptId,
      { message: error.message, responseCode: classification.responseCode, errorDetail: classification.errorDetail },
      attemptCount,
      maxAttempts,
      retryDelayMs,
      client
    );
  } else if (classification.category === 'ambiguous_outcome') {
    return recordAttemptAmbiguousOutcome(
      deliveryId,
      attemptId,
      { message: error.message, responseCode: classification.responseCode, errorDetail: classification.errorDetail },
      client
    );
  } else {
    return recordAttemptConnectionFailure(
      deliveryId,
      attemptId,
      { message: error.message, responseCode: classification.responseCode, errorDetail: classification.errorDetail },
      attemptCount,
      maxAttempts,
      retryDelayMs,
      client
    );
  }
}
