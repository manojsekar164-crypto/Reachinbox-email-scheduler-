/**
 * src/services/recoveryService.ts
 *
 * Email Failure & Recovery Center Service.
 *
 * Responsibilities:
 *  1. Failure & Unknown Delivery Monitoring:
 *     - Scoped strictly to authenticated user's campaigns.
 *     - Multi-criteria filtering (status, campaign, sender, error classification, date range).
 *     - Stable pagination and deterministic sorting.
 *     - Retry eligibility computation with transparent reasoning.
 *     - Sensitive sender credential sanitization (never exposes secrets).
 *
 *  2. Delivery Details & Immutable Attempt History:
 *     - Complete audit trail of attempts and operator resolutions.
 *
 *  3. Safe Manual Retry:
 *     - Validates failure classification permits retry.
 *     - Enforces max retry limits and policies.
 *     - Atomic PostgreSQL state transitions.
 *     - Deterministic outbox events with deduplication keys.
 *     - Prevents duplicate retry requests.
 *     - Strictly refuses to retry sent, cancelled, or unknown deliveries.
 *
 *  4. Unknown Delivery Operator Review:
 *     - Explicit operator resolution (confirmed_accepted | confirmed_not_accepted).
 *     - Mandatory reason enforcement.
 *     - Durable audit record in `delivery_resolutions`.
 *     - Reconciles confirmed_accepted without fabricating SMTP metadata.
 *     - Transitions confirmed_not_accepted to a state eligible for manual retry.
 *     - Never automatically retries unknown deliveries.
 *
 *  5. Campaign Lifecycle Controls:
 *     - Pause: prevents new delivery claims, reports in-flight dispatches.
 *     - Resume: republishes only eligible deliveries via outbox, never reactivates sent/unknown.
 *     - Cancel: prevents remaining dispatches, never reactivates sent/unknown.
 *     - Idempotent operations across restarts and concurrent calls.
 */

import { Pool, PoolClient } from 'pg';
import { Queue } from 'bullmq';
import { db as defaultPool } from '../db/postgres';
import { emailQueue as defaultQueue, EmailJobPayload } from '../queue/emailQueue';
import { EmailDeliveryRow, EmailAttemptRow, DeliveryStatus } from '../types/db.types';
import {
  ListDeliveriesOptions,
  PaginatedDeliveriesResult,
  DeliveryListItem,
  DeliveryDetailResult,
  RetryEligibilityInfo,
  ManualRetryResult,
  ResolveUnknownInput,
  ResolveUnknownResult,
  CancelCampaignOptions,
  CampaignControlResult,
  DeliveryResolutionRow,
} from '../types/recovery.types';
import { publishOutboxEvent, processOutboxBatch } from './outboxPublisher';

export const DEFAULT_MAX_RETRY_ATTEMPTS = 5;

/**
 * Evaluates whether an email delivery is eligible for manual retry.
 * Returns boolean and transparent descriptive reasoning.
 */
export function evaluateRetryEligibility(
  delivery: {
    status: DeliveryStatus;
    attempt_count: number;
    deleted_at: Date | string | null;
    lease_expires_at?: Date | string | null;
  },
  latestAttempt?: {
    error_classification?: string | null;
    error_message?: string | null;
    status?: string | null;
  } | null,
  campaignStatus?: string,
  maxAttempts = DEFAULT_MAX_RETRY_ATTEMPTS
): RetryEligibilityInfo {
  if (delivery.deleted_at !== null) {
    return { is_eligible: false, reason: 'Delivery has been deleted' };
  }

  if (delivery.status === 'sent') {
    return { is_eligible: false, reason: 'Delivery has already succeeded' };
  }

  if (delivery.status === 'unknown') {
    return {
      is_eligible: false,
      reason: 'Delivery outcome is uncertain. Requires operator review and resolution before retry.',
    };
  }

  if (delivery.status === 'cancelled') {
    return { is_eligible: false, reason: 'Delivery has been cancelled' };
  }

  if (campaignStatus === 'cancelled') {
    return { is_eligible: false, reason: 'Campaign has been cancelled' };
  }

  if (delivery.status === 'sending') {
    const isLeaseActive =
      delivery.lease_expires_at &&
      new Date(delivery.lease_expires_at).getTime() > Date.now();
    if (isLeaseActive) {
      return { is_eligible: false, reason: 'Delivery is currently in-flight' };
    }
  }

  if (delivery.attempt_count >= maxAttempts) {
    return {
      is_eligible: false,
      max_attempts_reached: true,
      reason: `Maximum retry attempts limit (${maxAttempts}) reached`,
    };
  }

  // Inspect failure classification
  const classification = latestAttempt?.error_classification;

  if (classification === 'permanent_rejection') {
    return {
      is_eligible: false,
      reason: 'Failure classified as permanent rejection (e.g. invalid recipient address, hard bounce, or authentication failure)',
    };
  }

  if (classification === 'ambiguous_outcome' || classification === 'stale_claim_reconciliation') {
    return {
      is_eligible: false,
      reason: 'Delivery outcome is uncertain and requires operator review before retry',
    };
  }

  if (classification === 'operator_confirmed_not_accepted') {
    return {
      is_eligible: true,
      reason: 'Operator confirmed message was not accepted. Manual retry authorized.',
    };
  }

  if (classification === 'transient_rejection') {
    return {
      is_eligible: true,
      reason: 'Transient SMTP error permits another attempt',
    };
  }

  if (classification === 'connection_failure') {
    return {
      is_eligible: true,
      reason: 'Connection failure before message acceptance permits another attempt',
    };
  }

  if (delivery.status === 'failed') {
    // If no explicit classification or other failure type, allow manual retry if not maxed out
    return {
      is_eligible: true,
      reason: 'Delivery failed with retryable outcome',
    };
  }

  if (delivery.status === 'retry_wait') {
    return {
      is_eligible: true,
      reason: 'Delivery is currently in retry wait and can be manually expedited',
    };
  }

  return {
    is_eligible: false,
    reason: `Delivery in status '${delivery.status}' is not eligible for manual retry`,
  };
}

/**
 * Lists deliveries with filtering, pagination, and sorting scoped to the authenticated user.
 */
export async function listDeliveries(
  options: ListDeliveriesOptions,
  client: Pool | PoolClient = defaultPool
): Promise<PaginatedDeliveriesResult> {
  const {
    userId,
    status,
    campaignId,
    senderId,
    errorClassification,
    fromDate,
    toDate,
    limit = 20,
    offset = 0,
    page = 1,
    sortBy = 'created_at',
    sortOrder = 'desc',
  } = options;

  const effectiveLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const effectiveOffset = Math.max(0, offset || (Number(page) - 1) * effectiveLimit);
  const effectivePage = Math.floor(effectiveOffset / effectiveLimit) + 1;

  const validSortColumns: Record<string, string> = {
    created_at: 'ed.created_at',
    updated_at: 'ed.updated_at',
    attempt_count: 'ed.attempt_count',
  };
  const sortColumn = validSortColumns[sortBy] || 'ed.created_at';
  const sortDirection = sortOrder?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const whereConditions: string[] = ['c.user_id = $1', 'ed.deleted_at IS NULL'];
  const params: any[] = [userId];

  if (status) {
    if (Array.isArray(status)) {
      params.push(status);
      whereConditions.push(`ed.status = ANY($${params.length}::varchar[])`);
    } else {
      params.push(status);
      whereConditions.push(`ed.status = $${params.length}`);
    }
  }

  if (campaignId) {
    params.push(campaignId);
    whereConditions.push(`ed.campaign_id = $${params.length}`);
  }

  if (senderId) {
    params.push(senderId);
    whereConditions.push(`ed.sender_id = $${params.length}`);
  }

  if (fromDate) {
    params.push(new Date(fromDate).toISOString());
    whereConditions.push(`ed.created_at >= $${params.length}::timestamptz`);
  }

  if (toDate) {
    params.push(new Date(toDate).toISOString());
    whereConditions.push(`ed.created_at <= $${params.length}::timestamptz`);
  }

  if (errorClassification) {
    params.push(errorClassification);
    whereConditions.push(`latest_attempt.error_classification = $${params.length}`);
  }

  const whereClause = whereConditions.join(' AND ');

  const query = `
    SELECT
      ed.id,
      ed.campaign_id,
      c.subject AS campaign_subject,
      c.status AS campaign_status,
      ed.recipient_id,
      r.email AS recipient_email,
      r.name AS recipient_name,
      ed.sender_id,
      s.email AS sender_email,
      s.name AS sender_name,
      ed.status,
      ed.attempt_count,
      ed.last_error,
      ed.scheduled_at,
      ed.sent_at,
      ed.next_attempt_at,
      ed.created_at,
      ed.updated_at,
      latest_attempt.id AS attempt_id,
      latest_attempt.attempt_number,
      latest_attempt.status AS attempt_status,
      latest_attempt.error_classification,
      latest_attempt.error_message,
      latest_attempt.smtp_response_code,
      latest_attempt.smtp_message_id,
      latest_attempt.attempted_at,
      latest_attempt.completed_at,
      COUNT(*) OVER() AS total_count
    FROM email_deliveries ed
    JOIN campaigns c ON c.id = ed.campaign_id
    JOIN recipients r ON r.id = ed.recipient_id
    LEFT JOIN senders s ON s.id = ed.sender_id
    LEFT JOIN LATERAL (
      SELECT
        ea.id,
        ea.attempt_number,
        ea.status,
        ea.error_classification,
        ea.error_message,
        ea.smtp_response_code,
        ea.smtp_message_id,
        ea.attempted_at,
        ea.completed_at
      FROM email_attempts ea
      WHERE ea.delivery_id = ed.id
      ORDER BY ea.attempt_number DESC, ea.attempted_at DESC
      LIMIT 1
    ) latest_attempt ON true
    WHERE ${whereClause}
    ORDER BY ${sortColumn} ${sortDirection}, ed.id ASC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2};
  `;

  const queryParams = [...params, effectiveLimit, effectiveOffset];
  const result = await client.query(query, queryParams);

  const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;
  const totalPages = Math.ceil(total / effectiveLimit);

  const deliveries: DeliveryListItem[] = result.rows.map((row) => {
    const latestAttempt = row.attempt_id
      ? {
          id: row.attempt_id,
          attempt_number: row.attempt_number,
          status: row.attempt_status,
          error_classification: row.error_classification,
          error_message: row.error_message,
          smtp_response_code: row.smtp_response_code,
          smtp_message_id: row.smtp_message_id,
          attempted_at: row.attempted_at ? new Date(row.attempted_at).toISOString() : '',
          completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
        }
      : null;

    const retryEligibility = evaluateRetryEligibility(
      {
        status: row.status,
        attempt_count: row.attempt_count,
        deleted_at: null,
      },
      latestAttempt,
      row.campaign_status
    );

    return {
      id: row.id,
      campaign_id: row.campaign_id,
      campaign_subject: row.campaign_subject,
      recipient_id: row.recipient_id,
      recipient_email: row.recipient_email,
      recipient_name: row.recipient_name,
      sender_id: row.sender_id,
      sender_email: row.sender_email,
      sender_name: row.sender_name,
      status: row.status,
      attempt_count: row.attempt_count,
      last_error: row.last_error,
      scheduled_at: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
      sent_at: row.sent_at ? new Date(row.sent_at).toISOString() : null,
      next_attempt_at: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      latest_attempt: latestAttempt,
      retry_eligibility: retryEligibility,
    };
  });

  return {
    deliveries,
    pagination: {
      total,
      page: effectivePage,
      limit: effectiveLimit,
      total_pages: totalPages,
      has_next: effectivePage < totalPages,
      has_prev: effectivePage > 1,
    },
  };
}

/**
 * Retrieves full details for an individual delivery including complete attempt history and resolutions.
 */
export async function getDeliveryDetail(
  deliveryId: string,
  userId: string,
  client: Pool | PoolClient = defaultPool
): Promise<DeliveryDetailResult> {
  const query = `
    SELECT
      ed.id,
      ed.campaign_id,
      c.subject AS campaign_subject,
      c.status AS campaign_status,
      ed.recipient_id,
      r.email AS recipient_email,
      r.name AS recipient_name,
      ed.sender_id,
      s.email AS sender_email,
      s.name AS sender_name,
      ed.status,
      ed.attempt_count,
      ed.last_error,
      ed.scheduled_at,
      ed.sent_at,
      ed.next_attempt_at,
      ed.created_at,
      ed.updated_at
    FROM email_deliveries ed
    JOIN campaigns c ON c.id = ed.campaign_id
    JOIN recipients r ON r.id = ed.recipient_id
    LEFT JOIN senders s ON s.id = ed.sender_id
    WHERE ed.id = $1
      AND c.user_id = $2
      AND ed.deleted_at IS NULL
    LIMIT 1;
  `;

  const result = await client.query(query, [deliveryId, userId]);
  if (result.rows.length === 0) {
    const error: any = new Error('Delivery not found or access denied');
    error.statusCode = 404;
    throw error;
  }

  const row = result.rows[0];

  // Retrieve complete immutable attempt history
  const attemptsRes = await client.query<EmailAttemptRow>(
    `SELECT *
     FROM email_attempts
     WHERE delivery_id = $1
     ORDER BY attempt_number ASC, attempted_at ASC;`,
    [deliveryId]
  );
  const attempts = attemptsRes.rows;

  // Retrieve operator resolutions history
  const resolutionsRes = await client.query<DeliveryResolutionRow>(
    `SELECT *
     FROM delivery_resolutions
     WHERE delivery_id = $1
     ORDER BY created_at ASC;`,
    [deliveryId]
  );
  const resolutions = resolutionsRes.rows;

  const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
  const retryEligibility = evaluateRetryEligibility(
    {
      status: row.status,
      attempt_count: row.attempt_count,
      deleted_at: null,
    },
    latestAttempt,
    row.campaign_status
  );

  return {
    id: row.id,
    campaign_id: row.campaign_id,
    campaign_subject: row.campaign_subject,
    recipient_id: row.recipient_id,
    recipient_email: row.recipient_email,
    recipient_name: row.recipient_name,
    sender_id: row.sender_id,
    sender_email: row.sender_email,
    sender_name: row.sender_name,
    status: row.status,
    attempt_count: row.attempt_count,
    last_error: row.last_error,
    scheduled_at: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
    sent_at: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    next_attempt_at: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    latest_attempt: latestAttempt
      ? {
          id: latestAttempt.id,
          attempt_number: latestAttempt.attempt_number,
          status: latestAttempt.status,
          error_classification: latestAttempt.error_classification,
          error_message: latestAttempt.error_message,
          smtp_response_code: latestAttempt.smtp_response_code,
          smtp_message_id: latestAttempt.smtp_message_id,
          attempted_at: new Date(latestAttempt.attempted_at).toISOString(),
          completed_at: latestAttempt.completed_at
            ? new Date(latestAttempt.completed_at).toISOString()
            : null,
        }
      : null,
    retry_eligibility: retryEligibility,
    attempts,
    resolutions,
  };
}

/**
 * Retrieves the complete email attempt history for a delivery, verifying user ownership.
 */
export async function getDeliveryAttemptHistory(
  deliveryId: string,
  userId: string,
  client: Pool | PoolClient = defaultPool
): Promise<EmailAttemptRow[]> {
  const ownershipRes = await client.query(
    `SELECT ed.id
     FROM email_deliveries ed
     JOIN campaigns c ON c.id = ed.campaign_id
     WHERE ed.id = $1 AND c.user_id = $2 AND ed.deleted_at IS NULL
     LIMIT 1;`,
    [deliveryId, userId]
  );

  if (ownershipRes.rows.length === 0) {
    const error: any = new Error('Delivery not found or access denied');
    error.statusCode = 404;
    throw error;
  }

  const attemptsRes = await client.query<EmailAttemptRow>(
    `SELECT *
     FROM email_attempts
     WHERE delivery_id = $1
     ORDER BY attempt_number ASC, attempted_at ASC;`,
    [deliveryId]
  );

  return attemptsRes.rows;
}

/**
 * Executes an authorized manual retry of a failed delivery.
 *
 * Invariants:
 *  - Verifies user ownership and failure classification eligibility.
 *  - Disallows retry of sent, cancelled, or unknown deliveries.
 *  - Enforces max retry attempt policy.
 *  - Prevents duplicate manual retry requests using PostgreSQL row lock and outbox deduplication key.
 *  - Preserves all historical attempt records.
 *  - Reuses outbox publisher and atomic claim mechanism.
 */
export async function manualRetryDelivery(
  deliveryId: string,
  userId: string,
  dbPool: Pool = defaultPool,
  queue: Queue<EmailJobPayload> = defaultQueue
): Promise<ManualRetryResult> {
  const client = await dbPool.connect();

  try {
    await client.query('BEGIN');

    // Lock delivery row for update to prevent concurrent duplicate retry requests
    const deliveryRes = await client.query<EmailDeliveryRow & { campaign_status: string }>(
      `SELECT ed.*, c.status AS campaign_status
       FROM email_deliveries ed
       JOIN campaigns c ON c.id = ed.campaign_id
       WHERE ed.id = $1 AND c.user_id = $2 AND ed.deleted_at IS NULL
       FOR UPDATE OF ed;`,
      [deliveryId, userId]
    );

    if (deliveryRes.rows.length === 0) {
      const error: any = new Error('Delivery not found or access denied');
      error.statusCode = 404;
      throw error;
    }

    const delivery = deliveryRes.rows[0];

    // Check if delivery is already sent, cancelled, or unknown
    if (delivery.status === 'sent') {
      const error: any = new Error('Cannot retry delivery: delivery has already been sent successfully');
      error.statusCode = 400;
      throw error;
    }

    if (delivery.status === 'unknown') {
      const error: any = new Error('Cannot retry delivery: delivery outcome is uncertain and requires operator review before retry');
      error.statusCode = 400;
      throw error;
    }

    if (delivery.status === 'cancelled') {
      const error: any = new Error('Cannot retry delivery: delivery has been cancelled');
      error.statusCode = 400;
      throw error;
    }

    if (delivery.campaign_status === 'cancelled') {
      const error: any = new Error('Cannot retry delivery: campaign has been cancelled');
      error.statusCode = 400;
      throw error;
    }

    // Check if delivery is actively in-flight
    if (delivery.status === 'sending') {
      const isLeaseActive =
        delivery.lease_expires_at &&
        new Date(delivery.lease_expires_at).getTime() > Date.now();
      if (isLeaseActive) {
        const error: any = new Error('Cannot retry delivery: delivery is currently in-flight');
        error.statusCode = 409;
        throw error;
      }
    }

    // Check if a retry request is already pending or processing in outbox
    const pendingOutbox = await client.query(
      `SELECT id FROM delivery_outbox
       WHERE aggregate_id = $1
         AND (payload->>'deliveryId') = $2
         AND status IN ('pending', 'processing');`,
      [delivery.campaign_id, delivery.id]
    );

    if (pendingOutbox.rows.length > 0) {
      const error: any = new Error('A retry request is already queued or in progress for this delivery');
      error.statusCode = 409;
      throw error;
    }

    // Retrieve latest attempt to evaluate classification
    const latestAttemptRes = await client.query<EmailAttemptRow>(
      `SELECT * FROM email_attempts
       WHERE delivery_id = $1
       ORDER BY attempt_number DESC, attempted_at DESC
       LIMIT 1;`,
      [delivery.id]
    );
    const latestAttempt = latestAttemptRes.rows[0] || null;

    const eligibility = evaluateRetryEligibility(
      delivery,
      latestAttempt,
      delivery.campaign_status
    );

    if (!eligibility.is_eligible) {
      const error: any = new Error(`Manual retry ineligible: ${eligibility.reason}`);
      error.statusCode = 400;
      throw error;
    }

    const nextAttemptNumber = delivery.attempt_count + 1;
    const dedupKey = `retry_${delivery.id}_attempt_${nextAttemptNumber}`;

    // Atomically transition delivery status to pending for dispatch
    await client.query(
      `UPDATE email_deliveries
       SET status = 'pending',
           next_attempt_at = NOW(),
           claim_owner = NULL,
           lease_expires_at = NULL,
           last_error = 'Manual retry authorized by operator',
           updated_at = NOW()
       WHERE id = $1;`,
      [delivery.id]
    );

    // Create a deterministic outbox event for the authorized retry attempt
    const outboxRes = await client.query<{ id: string }>(
      `INSERT INTO delivery_outbox (
         event_type,
         aggregate_id,
         deduplication_key,
         payload,
         status,
         available_at,
         created_at
       )
       VALUES ($1, $2, $3, $4, 'pending', NOW(), NOW())
       ON CONFLICT (deduplication_key) DO NOTHING
       RETURNING id;`,
      [
        'email.dispatch',
        delivery.campaign_id,
        dedupKey,
        JSON.stringify({
          deliveryId: delivery.id,
          campaignId: delivery.campaign_id,
          recipientId: delivery.recipient_id,
          scheduledAt: null,
          isRetry: true,
          retryAttempt: nextAttemptNumber,
        }),
      ]
    );

    if (outboxRes.rows.length === 0) {
      const error: any = new Error('A retry request is already queued or in progress for this delivery');
      error.statusCode = 409;
      throw error;
    }

    const outboxId = outboxRes.rows[0].id;

    await client.query('COMMIT');

    // Process outbox batch to publish job to BullMQ immediately
    try {
      await processOutboxBatch(10, `manual_retry_${Date.now()}`, 30000, dbPool, queue);
    } catch (publishErr: any) {
      console.warn(`⚠️ [ManualRetry] Outbox event queued, background dispatch pending: ${publishErr.message}`);
    }

    return {
      success: true,
      delivery_id: delivery.id,
      campaign_id: delivery.campaign_id,
      recipient_id: delivery.recipient_id,
      status: 'pending',
      attempt_number: nextAttemptNumber,
      outbox_event_id: outboxId,
      deduplication_key: dedupKey,
      message: `Manual retry successfully scheduled for attempt ${nextAttemptNumber}`,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resolves an unknown/ambiguous email delivery following operator review.
 *
 * Supported decisions:
 *  1. 'confirmed_accepted': Reconciles the delivery to 'sent' without inventing SMTP metadata.
 *  2. 'confirmed_not_accepted': Reconciles delivery to 'failed' with 'operator_confirmed_not_accepted'
 *     classification, making it eligible for manual retry.
 *
 * Invariants:
 *  - Requires mandatory reason.
 *  - Verifies campaign ownership.
 *  - Creates an immutable audit record in `delivery_resolutions`.
 *  - Never automatically retries unknown deliveries.
 */
export async function resolveUnknownDelivery(
  deliveryId: string,
  userId: string,
  input: ResolveUnknownInput,
  dbPool: Pool = defaultPool
): Promise<ResolveUnknownResult> {
  const { decision, reason, metadata } = input;

  if (!decision || (decision !== 'confirmed_accepted' && decision !== 'confirmed_not_accepted')) {
    const error: any = new Error("Invalid resolution decision: must be 'confirmed_accepted' or 'confirmed_not_accepted'");
    error.statusCode = 400;
    throw error;
  }

  if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
    const error: any = new Error('Mandatory resolution reason is required (minimum 3 characters)');
    error.statusCode = 400;
    throw error;
  }

  const client = await dbPool.connect();

  try {
    await client.query('BEGIN');

    // Lock delivery row for update
    const deliveryRes = await client.query<EmailDeliveryRow>(
      `SELECT ed.*
       FROM email_deliveries ed
       JOIN campaigns c ON c.id = ed.campaign_id
       WHERE ed.id = $1 AND c.user_id = $2 AND ed.deleted_at IS NULL
       FOR UPDATE OF ed;`,
      [deliveryId, userId]
    );

    if (deliveryRes.rows.length === 0) {
      const error: any = new Error('Delivery not found or access denied');
      error.statusCode = 404;
      throw error;
    }

    const delivery = deliveryRes.rows[0];

    if (delivery.status !== 'unknown') {
      const error: any = new Error(`Cannot resolve delivery: status is '${delivery.status}' (only 'unknown' deliveries can be resolved)`);
      error.statusCode = 400;
      throw error;
    }

    const previousStatus = delivery.status;
    let newStatus: DeliveryStatus;
    let resolutionMessage: string;

    if (decision === 'confirmed_accepted') {
      newStatus = 'sent';
      resolutionMessage = `Operator confirmed message was accepted: ${reason.trim()}`;

      // Update canonical delivery: DO NOT fabricate SMTP response code or message ID
      await client.query(
        `UPDATE email_deliveries
         SET status = 'sent',
             sent_at = COALESCE(sent_at, NOW()),
             last_error = $1,
             claim_owner = NULL,
             lease_expires_at = NULL,
             next_attempt_at = NULL,
             updated_at = NOW()
         WHERE id = $2;`,
        [resolutionMessage, delivery.id]
      );

      // Update latest attempt if in unknown status
      await client.query(
        `UPDATE email_attempts
         SET status = 'sent',
             error_classification = 'operator_confirmed_accepted',
             error_message = $1,
             completed_at = COALESCE(completed_at, NOW())
         WHERE id = (
           SELECT id FROM email_attempts
           WHERE delivery_id = $2
           ORDER BY attempt_number DESC, attempted_at DESC
           LIMIT 1
         ) AND status = 'unknown';`,
        [resolutionMessage, delivery.id]
      );
    } else {
      newStatus = 'failed';
      resolutionMessage = `Operator confirmed message was not accepted: ${reason.trim()}`;

      // Update canonical delivery to failed (now eligible for manual retry)
      await client.query(
        `UPDATE email_deliveries
         SET status = 'failed',
             last_error = $1,
             claim_owner = NULL,
             lease_expires_at = NULL,
             next_attempt_at = NULL,
             updated_at = NOW()
         WHERE id = $2;`,
        [resolutionMessage, delivery.id]
      );

      // Update latest attempt to failed with operator classification
      await client.query(
        `UPDATE email_attempts
         SET status = 'failed',
             error_classification = 'operator_confirmed_not_accepted',
             error_message = $1,
             completed_at = COALESCE(completed_at, NOW())
         WHERE id = (
           SELECT id FROM email_attempts
           WHERE delivery_id = $2
           ORDER BY attempt_number DESC, attempted_at DESC
           LIMIT 1
         ) AND status = 'unknown';`,
        [resolutionMessage, delivery.id]
      );
    }

    // Insert durable operator resolution audit record
    const auditRes = await client.query<{ id: string }>(
      `INSERT INTO delivery_resolutions (
         delivery_id,
         user_id,
         decision,
         reason,
         previous_status,
         new_status,
         metadata,
         created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING id;`,
      [
        delivery.id,
        userId,
        decision,
        reason.trim(),
        previousStatus,
        newStatus,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );

    const resolutionId = auditRes.rows[0].id;

    const refreshedRes = await client.query<EmailDeliveryRow>(
      `SELECT * FROM email_deliveries WHERE id = $1;`,
      [delivery.id]
    );

    await client.query('COMMIT');

    return {
      success: true,
      delivery_id: delivery.id,
      previous_status: previousStatus,
      new_status: newStatus,
      decision,
      reason: reason.trim(),
      resolution_id: resolutionId,
      message: `Delivery successfully resolved to '${newStatus}' by operator`,
      delivery: refreshedRes.rows[0],
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Pauses a campaign atomically.
 *
 * Invariants:
 *  - Uses a dedicated client and explicit transaction.
 *  - Locks campaign row FOR UPDATE to establish consistent locking order (campaigns -> deliveries).
 *  - Prevents new delivery claims (claimDelivery checks status = 'sending').
 *  - Accurately reports currently in-flight dispatches.
 *  - Idempotent: repeated pause requests return success.
 */
export async function pauseCampaign(
  campaignId: string,
  userId: string,
  dbPool: Pool | PoolClient = defaultPool
): Promise<CampaignControlResult> {
  const isPool = dbPool instanceof Pool || typeof (dbPool as any).totalCount === 'number';
  const client = isPool ? await (dbPool as Pool).connect() : (dbPool as PoolClient);

  try {
    await client.query('BEGIN');

    // 1. Lock campaign row for update and verify ownership
    const campRes = await client.query(
      `SELECT id, status FROM campaigns WHERE id = $1 AND user_id = $2 FOR UPDATE;`,
      [campaignId, userId]
    );

    if (campRes.rows.length === 0) {
      const error: any = new Error('Campaign not found or access denied');
      error.statusCode = 404;
      throw error;
    }

    const campaign = campRes.rows[0];

    if (campaign.status === 'completed' || campaign.status === 'cancelled') {
      const error: any = new Error(`Cannot pause a ${campaign.status} campaign`);
      error.statusCode = 400;
      throw error;
    }

    if (campaign.status === 'paused') {
      await client.query('COMMIT');
      return {
        success: true,
        campaign_id: campaignId,
        previous_status: 'paused',
        status: 'paused',
        message: 'Campaign is already paused',
        in_flight_count: 0,
      };
    }

    // 2. Count currently in-flight dispatches
    const inFlightRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM email_deliveries
       WHERE campaign_id = $1
         AND status = 'sending'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at > NOW()
         AND deleted_at IS NULL;`,
      [campaignId]
    );
    const inFlightCount = parseInt(inFlightRes.rows[0]?.count || '0', 10);

    // 3. Update campaign status to 'paused'
    await client.query(
      `UPDATE campaigns
       SET status = 'paused',
           updated_at = NOW()
       WHERE id = $1;`,
      [campaignId]
    );

    await client.query('COMMIT');

    const message =
      inFlightCount > 0
        ? `Campaign paused. ${inFlightCount} in-flight dispatches are completing and cannot be cancelled immediately.`
        : 'Campaign paused successfully. No new delivery claims will be processed.';

    return {
      success: true,
      campaign_id: campaignId,
      previous_status: campaign.status,
      status: 'paused',
      message,
      in_flight_count: inFlightCount,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    if (isPool) {
      (client as PoolClient).release();
    }
  }
}

/**
 * Resumes a paused campaign atomically.
 *
 * Invariants:
 *  - Transitions campaign status back to 'sending' (or 'scheduled' if scheduled_at > NOW).
 *  - Republishes only eligible outstanding deliveries through the outbox.
 *  - Strictly excludes 'sent', 'unknown', 'failed', or 'cancelled' deliveries.
 *  - Idempotent: repeated resume requests return success.
 */
export async function resumeCampaign(
  campaignId: string,
  userId: string,
  dbPool: Pool = defaultPool,
  queue: Queue<EmailJobPayload> = defaultQueue
): Promise<CampaignControlResult> {
  const campRes = await dbPool.query(
    `SELECT id, status, scheduled_at FROM campaigns WHERE id = $1 AND user_id = $2 LIMIT 1;`,
    [campaignId, userId]
  );

  if (campRes.rows.length === 0) {
    const error: any = new Error('Campaign not found or access denied');
    error.statusCode = 404;
    throw error;
  }

  const campaign = campRes.rows[0];

  if (campaign.status === 'completed' || campaign.status === 'cancelled') {
    const error: any = new Error(`Cannot resume a ${campaign.status} campaign`);
    error.statusCode = 400;
    throw error;
  }

  if (campaign.status === 'sending' || campaign.status === 'scheduled') {
    return {
      success: true,
      campaign_id: campaignId,
      previous_status: campaign.status,
      status: campaign.status,
      message: `Campaign is already ${campaign.status}`,
      republished_count: 0,
    };
  }

  const isFutureScheduled =
    campaign.scheduled_at && new Date(campaign.scheduled_at).getTime() > Date.now();
  const targetStatus = isFutureScheduled ? 'scheduled' : 'sending';

  const client = await dbPool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE campaigns
       SET status = $1,
           updated_at = NOW()
       WHERE id = $2;`,
      [targetStatus, campaignId]
    );

    // Republish ONLY eligible outstanding deliveries ('pending', 'scheduled', 'retry_wait')
    // Strictly exclude 'sent', 'unknown', 'failed', or 'cancelled'
    const republishRes = await client.query<{ id: string }>(
      `INSERT INTO delivery_outbox (
         event_type,
         aggregate_id,
         deduplication_key,
         payload,
         status,
         available_at,
         created_at
       )
       SELECT
         'email.dispatch',
         ed.campaign_id,
         'resume_' || ed.campaign_id || '_' || ed.recipient_id || '_' || ed.attempt_count,
         jsonb_build_object(
           'deliveryId', ed.id,
           'campaignId', ed.campaign_id,
           'recipientId', ed.recipient_id,
           'scheduledAt', ed.scheduled_at
         ),
         'pending',
         NOW(),
         NOW()
       FROM email_deliveries ed
       WHERE ed.campaign_id = $1
         AND ed.status IN ('pending', 'scheduled', 'retry_wait')
         AND ed.deleted_at IS NULL
       ON CONFLICT (deduplication_key) DO NOTHING
       RETURNING id;`,
      [campaignId]
    );

    const republishedCount = republishRes.rows.length;

    await client.query('COMMIT');

    // Trigger outbox batch processing
    try {
      await processOutboxBatch(50, `resume_${Date.now()}`, 30000, dbPool, queue);
    } catch (batchErr: any) {
      console.warn(`⚠️ [ResumeCampaign] Outbox events queued, async publishing pending: ${batchErr.message}`);
    }

    return {
      success: true,
      campaign_id: campaignId,
      previous_status: campaign.status,
      status: targetStatus,
      message: `Campaign resumed successfully to '${targetStatus}'. ${republishedCount} eligible deliveries queued.`,
      republished_count: republishedCount,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cancels a campaign atomically.
 *
 * Invariants:
 *  - Uses a dedicated PostgreSQL client and explicit transaction.
 *  - Locks and verifies campaign ownership before modifying anything.
 *  - Updates campaign status, eligible delivery records and pending outbox events in the same transaction.
 *  - Rolls back all changes if any operation fails.
 *  - Preserves sent and unknown deliveries.
 *  - Preserves active SMTP operations and reports their in-flight count.
 *  - Repeated cancellation requests are idempotent.
 *  - Never silently leaves partially cancelled campaign state.
 */
export async function cancelCampaign(
  campaignId: string,
  userId: string,
  dbPool: Pool | PoolClient = defaultPool,
  options?: CancelCampaignOptions
): Promise<CampaignControlResult> {
  const isPool = dbPool instanceof Pool || typeof (dbPool as any).totalCount === 'number';
  const client = isPool ? await (dbPool as Pool).connect() : (dbPool as PoolClient);

  try {
    await client.query('BEGIN');

    // 1. Lock and verify campaign ownership before modifying anything
    const campRes = await client.query(
      `SELECT id, status FROM campaigns WHERE id = $1 AND user_id = $2 FOR UPDATE;`,
      [campaignId, userId]
    );

    if (campRes.rows.length === 0) {
      const error: any = new Error('Campaign not found or access denied');
      error.statusCode = 404;
      throw error;
    }

    const campaign = campRes.rows[0];

    // Idempotent: repeated cancellation requests return success
    if (campaign.status === 'cancelled') {
      await client.query('COMMIT');
      return {
        success: true,
        campaign_id: campaignId,
        previous_status: 'cancelled',
        status: 'cancelled',
        message: 'Campaign is already cancelled',
        cancelled_count: 0,
        in_flight_count: 0,
      };
    }

    // 2. Preserve active SMTP operations and report their in-flight count
    const inFlightRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM email_deliveries
       WHERE campaign_id = $1
         AND status = 'sending'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at > NOW()
         AND deleted_at IS NULL;`,
      [campaignId]
    );
    const inFlightCount = parseInt(inFlightRes.rows[0]?.count || '0', 10);

    // 3. Update campaign status to 'cancelled'
    await client.query(
      `UPDATE campaigns
       SET status = 'cancelled',
           updated_at = NOW()
       WHERE id = $1;`,
      [campaignId]
    );

    // 4. Update eligible delivery records
    // Eligible: 'pending', 'scheduled', 'retry_wait'
    // STRICTLY PRESERVE 'sent', 'unknown', and active 'sending'
    const cancelDeliveriesRes = await client.query<{ id: string }>(
      `UPDATE email_deliveries
       SET status = 'cancelled',
           last_error = 'Campaign cancelled by operator',
           claim_owner = NULL,
           lease_expires_at = NULL,
           next_attempt_at = NULL,
           updated_at = NOW()
       WHERE campaign_id = $1
         AND status IN ('pending', 'scheduled', 'retry_wait')
         AND deleted_at IS NULL
       RETURNING id;`,
      [campaignId]
    );
    const cancelledCount = cancelDeliveriesRes.rows.length;

    // 5. Cancel pending/processing outbox events for this campaign
    await client.query(
      `UPDATE delivery_outbox
       SET status = 'failed',
           last_error = 'Campaign cancelled by operator',
           claim_owner = NULL,
           lease_expires_at = NULL
       WHERE aggregate_id = $1
         AND status IN ('pending', 'processing');`,
      [campaignId]
    );

    // Optional test failure injection to verify transaction rollback atomicity
    if (options?.injectFailure) {
      throw new Error('Injected failure during campaign cancellation transaction');
    }

    await client.query('COMMIT');

    const message =
      inFlightCount > 0
        ? `Campaign cancelled. ${cancelledCount} outstanding deliveries cancelled. ${inFlightCount} active in-flight dispatches are completing.`
        : `Campaign cancelled successfully. ${cancelledCount} outstanding deliveries cancelled.`;

    return {
      success: true,
      campaign_id: campaignId,
      previous_status: campaign.status,
      status: 'cancelled',
      message,
      cancelled_count: cancelledCount,
      in_flight_count: inFlightCount,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    if (isPool) {
      (client as PoolClient).release();
    }
  }
}
