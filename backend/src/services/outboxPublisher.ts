/**
 * src/services/outboxPublisher.ts
 *
 * Dedicated Transactional Outbox Publisher & Queue Recovery Service.
 *
 * Responsibilities:
 *  1. Atomically claims pending or expired outbox records using `FOR UPDATE SKIP LOCKED`.
 *  2. Publishes jobs to BullMQ with deterministic deduplication keys and delay offsets.
 *  3. Marks outbox records 'dispatched' ONLY after successful BullMQ confirmation.
 *  4. Recovers expired publisher leases if a previous publisher crashed during publishing.
 *  5. Reconciles legitimate future scheduled deliveries from PostgreSQL into BullMQ.
 *  6. Guarantees that historical unknown, sent, cancelled, and draft deliveries are NEVER replayed.
 */

import { Pool, PoolClient } from 'pg';
import { Queue } from 'bullmq';
import { db as defaultPool } from '../db/postgres';
import { emailQueue as defaultQueue, EmailJobPayload } from '../queue/emailQueue';
import { DeliveryOutboxRow } from '../types/db.types';

export interface OutboxPublishResult {
  claimed: number;
  dispatched: number;
  failed: number;
}

export interface OutboxPayloadData {
  deliveryId: string;
  campaignId: string;
  recipientId: string;
  scheduledAt: string | null;
}

/**
 * Atomically claims up to `batchSize` outbox records for publishing.
 *
 * Invariant:
 *  - Only claims records where status = 'pending' AND available_at <= NOW(), OR
 *    status = 'processing' AND lease_expires_at < NOW() (expired lease recovery).
 *  - Concurrently running publishers skip locked rows (SKIP LOCKED) and never
 *    claim the same record.
 */
export async function claimOutboxRecords(
  batchSize = 50,
  claimOwner: string,
  leaseDurationMs = 30000,
  client: Pool | PoolClient = defaultPool
): Promise<DeliveryOutboxRow[]> {
  const query = `
    WITH claimable AS (
      SELECT id
      FROM delivery_outbox
      WHERE (
        (status = 'pending' AND available_at <= NOW())
        OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW())
      )
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    )
    UPDATE delivery_outbox outbox
    SET status = 'processing',
        claim_owner = $2,
        claimed_at = NOW(),
        lease_expires_at = NOW() + ($3 || ' milliseconds')::INTERVAL,
        attempt_count = outbox.attempt_count + 1
    FROM claimable
    WHERE outbox.id = claimable.id
    RETURNING outbox.*;
  `;

  const result = await client.query<DeliveryOutboxRow>(query, [
    batchSize,
    claimOwner,
    leaseDurationMs,
  ]);

  return result.rows;
}

/**
 * Marks an outbox event as dispatched after verified BullMQ job creation.
 */
export async function markOutboxDispatched(
  outboxId: string,
  client: Pool | PoolClient = defaultPool
): Promise<void> {
  await client.query(
    `UPDATE delivery_outbox
     SET status = 'dispatched',
         dispatched_at = NOW(),
         claim_owner = NULL,
         lease_expires_at = NULL,
         last_error = NULL
     WHERE id = $1`,
    [outboxId]
  );
}

/**
 * Marks an outbox event as failed or returns it to pending with backoff if retries remain.
 */
export async function markOutboxFailed(
  outboxId: string,
  errorMessage: string,
  maxAttempts = 5,
  retryDelayMs = 5000,
  client: Pool | PoolClient = defaultPool
): Promise<void> {
  await client.query(
    `UPDATE delivery_outbox
     SET status = CASE WHEN attempt_count >= $2 THEN 'failed' ELSE 'pending' END,
         available_at = NOW() + ($3 || ' milliseconds')::INTERVAL,
         claim_owner = NULL,
         lease_expires_at = NULL,
         last_error = $4
     WHERE id = $1`,
    [outboxId, maxAttempts, retryDelayMs, errorMessage]
  );
}

/**
 * Publishes a single claimed outbox record into BullMQ.
 * Calculates delay based on `scheduledAt` and marks outbox dispatched upon success.
 */
export async function publishOutboxEvent(
  outboxRow: DeliveryOutboxRow,
  queue: Queue<EmailJobPayload> = defaultQueue,
  client: Pool | PoolClient = defaultPool
): Promise<void> {
  const payload: OutboxPayloadData =
    typeof outboxRow.payload === 'string'
      ? JSON.parse(outboxRow.payload)
      : outboxRow.payload;

  let delayMs = 0;
  if (payload.scheduledAt) {
    const scheduledTime = new Date(payload.scheduledAt).getTime();
    const now = Date.now();
    delayMs = Math.max(0, scheduledTime - now);
  }

  // Publish to BullMQ with deterministic deduplication key
  await queue.add(
    'send-email',
    {
      campaignId: payload.campaignId,
      recipientId: payload.recipientId,
      deliveryId: payload.deliveryId,
    },
    {
      jobId: outboxRow.deduplication_key,
      delay: delayMs,
    }
  );

  // Update outbox status to dispatched only AFTER successful queue addition
  await markOutboxDispatched(outboxRow.id, client);
}

/**
 * Processes a single batch of outbox records.
 */
export async function processOutboxBatch(
  batchSize = 50,
  claimOwner?: string,
  leaseDurationMs = 30000,
  client: Pool = defaultPool,
  queue: Queue<EmailJobPayload> = defaultQueue
): Promise<OutboxPublishResult> {
  const owner = claimOwner || `publisher_${process.pid}_${Date.now()}`;
  const claimedRecords = await claimOutboxRecords(batchSize, owner, leaseDurationMs, client);

  let dispatched = 0;
  let failed = 0;

  for (const record of claimedRecords) {
    try {
      await publishOutboxEvent(record, queue, client);
      dispatched++;
    } catch (err: any) {
      console.error(
        `❌ [OutboxPublisher] Failed to publish outbox event ${record.id} (${record.deduplication_key}): ${err.message}`
      );
      await markOutboxFailed(record.id, err.message, 5, 5000, client);
      failed++;
    }
  }

  return {
    claimed: claimedRecords.length,
    dispatched,
    failed,
  };
}

/**
 * Reconciles legitimate future scheduled deliveries from PostgreSQL into `delivery_outbox`.
 *
 * Invariants:
 *  - Recovers ONLY campaigns where status = 'scheduled' AND scheduled_at > NOW().
 *  - Strictly excludes 'sent', 'failed', 'unknown', 'cancelled', and 'draft' deliveries.
 *  - Idempotent: `ON CONFLICT (deduplication_key) DO NOTHING` prevents duplicate outbox events.
 */
export async function recoverFutureScheduledDeliveries(
  client: Pool | PoolClient = defaultPool
): Promise<number> {
  const query = `
    WITH inserted AS (
      INSERT INTO delivery_outbox (
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
        ed.id,
        'campaign_' || ed.campaign_id || '_' || ed.recipient_id,
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
      JOIN campaigns c ON c.id = ed.campaign_id
      WHERE ed.status = 'scheduled'
        AND c.status = 'scheduled'
        AND ed.scheduled_at IS NOT NULL
        AND ed.scheduled_at > NOW()
        AND ed.deleted_at IS NULL
      ON CONFLICT (deduplication_key) DO NOTHING
      RETURNING id
    )
    SELECT COUNT(*) as cnt FROM inserted;
  `;

  const result = await client.query<{ cnt: string }>(query);
  const count = parseInt(result.rows[0]?.cnt || '0', 10);
  if (count > 0) {
    console.log(`📦 [OutboxRecovery] Reconciled ${count} future scheduled deliveries into outbox.`);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Background Publisher Poller (In-Memory Daemon)
// ---------------------------------------------------------------------------

let publisherTimer: NodeJS.Timeout | null = null;
let isPublishing = false;

/**
 * Starts the in-memory outbox publisher polling daemon.
 */
export function startOutboxPublisher(options?: { intervalMs?: number; batchSize?: number }): void {
  const intervalMs = options?.intervalMs || 1000;
  const batchSize = options?.batchSize || 50;

  if (publisherTimer) {
    return; // Already running
  }

  console.log(`📢 Starting Outbox Publisher (poll interval: ${intervalMs}ms, batchSize: ${batchSize})`);

  publisherTimer = setInterval(async () => {
    if (isPublishing) return;
    isPublishing = true;
    try {
      const result = await processOutboxBatch(batchSize);
      if (result.dispatched > 0) {
        console.log(`📢 [OutboxPublisher] Dispatched ${result.dispatched} outbox event(s) to BullMQ.`);
      }
    } catch (err: any) {
      console.error(`❌ [OutboxPublisher] Poller error: ${err.message}`);
    } finally {
      isPublishing = false;
    }
  }, intervalMs);

  // Run initial reconciliation on startup
  recoverFutureScheduledDeliveries().catch((err) => {
    console.error(`❌ [OutboxPublisher] Initial recovery failed: ${err.message}`);
  });
}

/**
 * Stops the in-memory outbox publisher polling daemon.
 */
export function stopOutboxPublisher(): void {
  if (publisherTimer) {
    clearInterval(publisherTimer);
    publisherTimer = null;
    console.log('🛑 Outbox Publisher stopped.');
  }
}
