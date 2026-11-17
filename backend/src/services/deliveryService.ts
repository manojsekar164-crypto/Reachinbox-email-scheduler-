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
 * Detects whether an SMTP error represents an uncertain outcome (in-doubt delivery).
 * In an uncertain delivery, the client cannot verify if the remote SMTP server
 * accepted and queued/delivered the message before the connection was severed.
 * Such deliveries MUST NOT be blindly retried.
 */
export function isUncertainSmtpError(error: any): boolean {
  if (!error) return false;
  if (error.isUncertain === true) return true;

  const code = (error.code || '').toUpperCase();
  const msg = (error.message || '').toLowerCase();

  const uncertainCodes = ['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EPIPE'];
  if (uncertainCodes.includes(code)) {
    return true;
  }

  const uncertainSubstrings = [
    'timeout',
    'socket hung up',
    'connection lost',
    'connection reset',
    'broken pipe',
    'in-doubt',
    'uncertain',
    'timed out',
  ];

  return uncertainSubstrings.some((sub) => msg.includes(sub));
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
 */
export async function recordAttemptSuccess(
  deliveryId: string,
  attemptId: string,
  smtpMessageId: string | null,
  client: Pool | PoolClient = defaultPool
): Promise<void> {
  // Update attempt history
  await client.query(
    `UPDATE email_attempts
     SET status = 'sent',
         smtp_message_id = $1,
         completed_at = NOW()
     WHERE id = $2`,
    [smtpMessageId, attemptId]
  );

  // Update canonical delivery
  await client.query(
    `UPDATE email_deliveries
     SET status = 'sent',
         sent_at = NOW(),
         smtp_message_id = $1,
         last_error = NULL,
         claim_owner = NULL,
         lease_expires_at = NULL,
         updated_at = NOW()
     WHERE id = $2`,
    [smtpMessageId, deliveryId]
  );
}

/**
 * Records an uncertain delivery outcome.
 * Marks both the attempt and canonical delivery as 'unknown'.
 * Clears claim lease so it is not locked, but leaves it in non-dispatchable 'unknown' state.
 */
export async function recordAttemptUncertain(
  deliveryId: string,
  attemptId: string,
  error: { message: string; code?: string },
  client: Pool | PoolClient = defaultPool
): Promise<void> {
  const errorMsg = `Uncertain SMTP delivery outcome: ${error.message || 'Connection lost during dispatch'}`;

  // Update attempt history
  await client.query(
    `UPDATE email_attempts
     SET status = 'unknown',
         smtp_response_code = $1,
         error_message = $2,
         completed_at = NOW()
     WHERE id = $3`,
    [error.code || null, errorMsg, attemptId]
  );

  // Update canonical delivery to terminal 'unknown'
  await client.query(
    `UPDATE email_deliveries
     SET status = 'unknown',
         last_error = $1,
         claim_owner = NULL,
         lease_expires_at = NULL,
         next_attempt_at = NULL,
         updated_at = NOW()
     WHERE id = $2`,
    [errorMsg, deliveryId]
  );
}

/**
 * Records a definite failure in `email_attempts` and updates the canonical delivery.
 * If retries remain, sets status to 'retry_wait'; otherwise sets status to 'failed'.
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
  const isFinal = attemptCount >= maxAttempts;
  const targetStatus: DeliveryStatus = isFinal ? 'failed' : 'retry_wait';

  // Update attempt history
  await client.query(
    `UPDATE email_attempts
     SET status = 'failed',
         smtp_response_code = $1,
         error_message = $2,
         completed_at = NOW()
     WHERE id = $3`,
    [error.code || null, error.message || 'SMTP dispatch failed', attemptId]
  );

  const nextAttemptClause =
    targetStatus === 'retry_wait' && retryDelayMs > 0
      ? `NOW() + (${Number(retryDelayMs)} || ' milliseconds')::INTERVAL`
      : 'NULL';

  // Update canonical delivery
  await client.query(
    `UPDATE email_deliveries
     SET status = $1,
         last_error = $2,
         claim_owner = NULL,
         lease_expires_at = NULL,
         next_attempt_at = ${nextAttemptClause},
         updated_at = NOW()
     WHERE id = $3`,
    [targetStatus, error.message || 'SMTP dispatch failed', deliveryId]
  );
}
