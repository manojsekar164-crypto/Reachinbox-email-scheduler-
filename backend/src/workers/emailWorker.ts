import { Worker, Job, DelayedError } from 'bullmq';
import { emailQueueName, EmailJobPayload, redisConnectionOptions } from '../queue/emailQueue';
import { sendEmail, SendEmailResult } from '../services/emailService';
import {
  reserveSendSlot,
  getGlobalHourlyLimit,
  checkRateLimit,
  checkSenderRateLimit,
} from '../services/rateLimiter';
import { handleRateLimitNotification, notifyCampaignCompleted } from '../services/slackService';
import { indexEmailAsSent } from '../services/searchService';
import { db as pool } from '../db/postgres';
import { CampaignRow, RecipientRow } from '../types/db.types';
import { config } from '../config';
import { getSenderByIdInternal } from '../services/senderService';
import { checkSendSpacing } from '../services/sendSpacing';
import {
  claimDelivery,
  getDelivery,
  ensureDeliveryRecord,
  releaseDeliveryClaim,
  recordAttemptStart,
  recordAttemptSuccess,
  recordAttemptPermanentRejection,
  recordAttemptTransientRejection,
  recordAttemptConnectionFailure,
  recordAttemptAmbiguousOutcome,
  recordPostgresPersistenceFailure,
  reconcileStaleDeliveries,
  classifySmtpOutcome,
  isUncertainSmtpError,
  activateDueCampaign,
} from '../services/deliveryService';

/**
 * src/workers/emailWorker.ts
 *
 * BullMQ Worker for processing email jobs.
 *
 * BATCH 1 ENHANCEMENTS:
 *  - Uses `email_deliveries` as the canonical delivery state machine.
 *  - Implements atomic claiming via `claimDelivery` (FOR UPDATE SKIP LOCKED).
 *  - Records attempt-by-attempt audit logs in `email_attempts`.
 *  - Never resends an already-sent delivery.
 *  - Never automatically retries an uncertain SMTP outcome ('unknown').
 *  - Preserves historical email_logs logging for backward compatibility.
 */

const workerConcurrency = config.app.workerConcurrency;
console.log(`👷 Starting worker for queue: ${emailQueueName}`);
console.log(`⚙️  Concurrency: ${workerConcurrency}`);

/**
 * Core email processing function.
 * Exported for deterministic unit & integration testing.
 */
export async function processEmailJob(
  job: {
    id?: string;
    data: EmailJobPayload & {
      simulateFailure?: boolean;
      simulateUncertain?: boolean;
      simulateDbFailureAfterSend?: boolean;
      simulateNoResponseCode?: boolean;
      leaseDurationMs?: number;
      onSmtpAccepted?: () => Promise<void>;
      testWindowSeconds?: number;
      testSendDelayMs?: number;
      testGlobalLimit?: number;
    };
    attemptsMade: number;
    opts?: { attempts?: number };
    token?: string;
    moveToDelayed?: (timestamp: number, token?: string) => Promise<void>;
  },
  dbClient = pool
): Promise<void> {
  const {
    campaignId,
    recipientId,
    simulateFailure,
    simulateUncertain,
    simulateDbFailureAfterSend,
    simulateNoResponseCode,
    leaseDurationMs,
    onSmtpAccepted,
    testWindowSeconds,
    testSendDelayMs,
    testGlobalLimit,
  } = job.data;
  const attempt = job.attemptsMade + 1;
  const jobId = job.id || `direct_${Date.now()}`;

  console.log(`\n⏳ [Job ${jobId}] Attempt ${attempt}`);
  console.log(`   campaign=${campaignId}`);
  console.log(`   recipient=${recipientId}`);

  // --- 0. Event-Driven Stale Delivery Reconciliation (Bounded) ---
  await maybeReconcileStaleDeliveries(dbClient);

  // --- 1. Load Campaign and Recipient ---
  const campaignResult = await dbClient.query<CampaignRow>(
    'SELECT * FROM campaigns WHERE id = $1',
    [campaignId]
  );
  let campaign = campaignResult.rows[0];

  const recipientResult = await dbClient.query<RecipientRow>(
    'SELECT * FROM recipients WHERE id = $1',
    [recipientId]
  );
  const recipient = recipientResult.rows[0];

  if (!campaign || !recipient) {
    throw new Error(`Job missing DB records: campaignId=${campaignId}, recipientId=${recipientId}`);
  }

  // --- 1.5. Canonical Delivery Idempotency & Eligibility Checks ---
  let delivery = await getDelivery(campaignId, recipientId, dbClient);
  if (!delivery) {
    delivery = await ensureDeliveryRecord(
      {
        campaignId,
        recipientId,
        senderId: campaign.sender_id || null,
        scheduledAt: campaign.scheduled_at,
      },
      dbClient
    );
  }

  // Invariant 1: Never send an already-sent delivery
  if (delivery.status === 'sent') {
    console.log(`   ⏭️ [Job ${jobId}] Idempotency check: Delivery is already marked 'sent'. Skipping.`);
    return;
  }

  // Invariant 2: Never automatically retry an uncertain SMTP outcome
  if (delivery.status === 'unknown') {
    console.log(
      `   ⚠️ [Job ${jobId}] Delivery outcome is uncertain (status: 'unknown'). Never automatically retrying. Skipping.`
    );
    return;
  }

  // Invariant 3: Exclude soft-deleted or cancelled deliveries
  if (delivery.deleted_at !== null || delivery.status === 'cancelled') {
    console.log(`   ⏭️ [Job ${jobId}] Delivery is cancelled or soft-deleted. Skipping.`);
    return;
  }

  // Invariant 3.5: Stale in-flight delivery safety
  // Never automatically resend a delivery that is currently in 'sending' status.
  // If its lease has expired, prioritize reconciling it to 'unknown' immediately.
  if (delivery.status === 'sending') {
    const isLeaseExpired =
      delivery.lease_expires_at && new Date(delivery.lease_expires_at).getTime() <= Date.now();
    if (isLeaseExpired) {
      console.log(
        `   ⚠️ [Job ${jobId}] Stale in-flight delivery detected (status: 'sending' with expired lease). Reconciling to 'unknown'.`
      );
      await reconcileStaleDeliveries(dbClient);
      const refreshed = await getDelivery(campaignId, recipientId, dbClient);
      if (refreshed && refreshed.status === 'unknown') {
        console.log(
          `   ⚠️ [Job ${jobId}] Delivery outcome is uncertain (status: 'unknown'). Never automatically retrying. Skipping.`
        );
        return;
      }
    } else {
      console.log(
        `   ⏸️ [Job ${jobId}] Delivery is actively in-flight (status: 'sending' with active lease). Skipping.`
      );
      return;
    }
  }

  // --- Scheduled Campaign Check & Due Activation ---
  if (campaign.status === 'scheduled') {
    if (campaign.scheduled_at && new Date(campaign.scheduled_at).getTime() > Date.now()) {
      console.log(
        `   ⏳ [Job ${jobId}] Campaign scheduled for future (${campaign.scheduled_at}). Cannot execute before scheduled_at. Skipping.`
      );
      return;
    }
    // Campaign is due! Atomically activate it:
    await activateDueCampaign(campaignId, dbClient);
    const reloaded = await dbClient.query<CampaignRow>('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
    if (reloaded.rows[0]) {
      campaign = reloaded.rows[0];
    }
  }

  // Invariant 4: Campaign must be eligible (must be in 'sending' status)
  if (campaign.status !== 'sending') {
    console.log(
      `   ⏸️ [Job ${jobId}] Campaign status is '${campaign.status}' (not 'sending'). Skipping claim.`
    );
    return;
  }

  // Backward compatibility check on historical email_logs
  const sentCheck = await dbClient.query(
    "SELECT id FROM email_logs WHERE campaign_id = $1 AND recipient_id = $2 AND status = 'sent' LIMIT 1",
    [campaignId, recipientId]
  );
  if (sentCheck.rows.length > 0) {
    console.log(`   ⏭️ [Job ${jobId}] Legacy log check: Already sent in email_logs. Skipping.`);
    return;
  }

  // --- 2. Atomic Delivery Claiming (FOR UPDATE SKIP LOCKED) ---
  const workerClaimOwner = `worker_${process.pid}_job_${jobId}`;
  const claimedDelivery = await claimDelivery({
    campaignId,
    recipientId,
    claimOwner: workerClaimOwner,
    leaseDurationMs: leaseDurationMs || 60000,
    dbClient,
  });

  if (!claimedDelivery) {
    console.log(
      `   ⏭️ [Job ${jobId}] Could not claim delivery (concurrently claimed, ineligible, or already processed). Skipping.`
    );
    return;
  }

  console.log(
    `   🔒 [Job ${jobId}] Atomically claimed delivery ${claimedDelivery.id} (owner: ${workerClaimOwner})`
  );

  // --- 2.5. Load and Verify Sender if configured ---
  let sender = null;
  if (campaign.sender_id) {
    sender = await getSenderByIdInternal(campaign.sender_id, dbClient);
    if (!sender) {
      await releaseDeliveryClaim(claimedDelivery.id, 'failed', 0, dbClient);
      throw new Error(
        `Job missing DB records: senderId=${campaign.sender_id} referenced by campaignId=${campaignId}`
      );
    }
    if (sender.user_id !== campaign.user_id) {
      await releaseDeliveryClaim(claimedDelivery.id, 'failed', 0, dbClient);
      throw new Error(
        `Security validation failed: Sender user_id ${sender.user_id} does not match campaign user_id ${campaign.user_id}.`
      );
    }
  }

  // --- 2.6. Unified Atomic Rate Limit & Minimum Send Spacing Reservation ---
  const sendDelayMs =
    testSendDelayMs !== undefined
      ? testSendDelayMs
      : config.app.emailSendDelayMs;

  const globalLimit =
    testGlobalLimit !== undefined
      ? testGlobalLimit
      : getGlobalHourlyLimit();

  const windowSeconds =
    testWindowSeconds ||
    (process.env['RATE_LIMIT_WINDOW_SECONDS']
      ? parseInt(process.env['RATE_LIMIT_WINDOW_SECONDS'], 10)
      : config.app.rateLimitWindow);

  const reservation = await reserveSendSlot({
    campaignId,
    campaignLimit: campaign.hourly_limit,
    senderId: sender ? sender.id : null,
    senderLimit: sender ? sender.hourly_limit : null,
    globalLimit,
    windowSeconds,
    sendDelayMs,
  });

  if (!reservation.allowed) {
    const { waitMs, reason } = reservation;
    console.log(
      `   ⏳ [Job ${jobId}] Rate limit / spacing restriction reached (${reason}). Delaying for ${waitMs}ms`
    );

    const effectiveDelayMs = Math.max(waitMs, reason === 'spacing' ? 10 : 1000);

    // Release delivery claim safely: resets attempt_count, transitions status to retry_wait, persists next_attempt_at
    await releaseDeliveryClaim(claimedDelivery.id, 'retry_wait', effectiveDelayMs, dbClient);

    // Send rate-limit alert via Slack if campaign, sender, or global limit was reached
    if (reason === 'campaign' || reason === 'sender' || reason === 'global') {
      await handleRateLimitNotification({
        campaignId,
        reason,
        waitMs,
        campaignLimit: campaign.hourly_limit,
        senderId: sender ? sender.id : null,
        senderEmail: sender ? sender.email : null,
        senderLimit: sender ? sender.hourly_limit : null,
        globalLimit,
      });
    }

    if (job.moveToDelayed) {
      await job.moveToDelayed(Date.now() + effectiveDelayMs, job.token);
      throw new DelayedError();
    }
    return;
  }

  // --- 3. Build Email Content ---
  const nameReplacement = recipient.name || 'there';
  const subject = campaign.subject.replace(/\{\{name\}\}/g, nameReplacement);
  const bodyText = campaign.body.replace(/\{\{name\}\}/g, nameReplacement);
  const bodyHtml = bodyText.replace(/\n/g, '<br>');

  // --- 4. Record Attempt Start in email_attempts ---
  const attemptId = await recordAttemptStart(
    claimedDelivery.id,
    claimedDelivery.attempt_count,
    campaign.sender_id || null,
    dbClient
  );

  // --- 6. Send Email via Nodemailer (Isolated SMTP Error Boundary) ---
  let sendResult: SendEmailResult | null = null;
  let smtpConfirmed = false;

  try {
    // Simulated Intentional Failure for Testing Retries
    if (simulateFailure && attempt === 1 && config.app.nodeEnv !== 'production') {
      const simError: any = new Error('Simulated processing failure for testing retries.');
      simError.code = 'ESIMULATED';
      throw simError;
    }

    // Simulated Uncertain Delivery Outcome for Testing
    if (simulateUncertain && config.app.nodeEnv !== 'production') {
      const timeoutError: any = new Error('Connection timeout waiting for SMTP 250 OK response');
      timeoutError.code = 'ETIMEDOUT';
      timeoutError.isUncertain = true;
      throw timeoutError;
    }

    console.log(`   ✉️ [Job ${jobId}] Sending email via Nodemailer...`);
    sendResult = await sendEmail({
      sender: sender || undefined,
      to: recipient.email,
      subject,
      text: bodyText,
      html: bodyHtml,
    });
    smtpConfirmed = true;

    if (onSmtpAccepted && config.app.nodeEnv !== 'production') {
      await onSmtpAccepted();
    }
  } catch (smtpError: any) {
    // STRICT ISOLATED SMTP ERROR BOUNDARY:
    // Only actual SMTP or network transport errors are classified and handled here.
    // PostgreSQL persistence errors are strictly excluded.
    const classification = classifySmtpOutcome(smtpError);
    const safeErrorDescription = classification.errorDetail || smtpError.message || 'Unknown SMTP error';

    // Outcome Category 5: Ambiguous SMTP outcome (connection lost or timeout during/after DATA)
    // Invariant: Never automatically retry an ambiguous (unknown) delivery
    if (classification.category === 'ambiguous_outcome') {
      console.error(
        `   ⚠️ [Job ${jobId}] Ambiguous SMTP outcome detected (${safeErrorDescription}). Marking as 'unknown'. Never blindly resending.`
      );

      await recordAttemptAmbiguousOutcome(
        claimedDelivery.id,
        attemptId,
        classification,
        dbClient
      );

      // Record in historical email_logs as failed with uncertain detail
      await dbClient.query(
        "INSERT INTO email_logs (campaign_id, recipient_id, sender_id, status, error_message, sent_at) VALUES ($1, $2, $3, 'failed', $4, NULL)",
        [campaignId, recipientId, campaign.sender_id || null, `Ambiguous outcome: ${safeErrorDescription}`]
      );

      // Complete job cleanly WITHOUT rethrowing to prevent BullMQ from auto-retrying
      return;
    }

    // Outcome Category 2: Definitive permanent rejection (5xx or auth failure)
    // Invariant: Non-retryable. Never automatically retry a permanent failure with identical parameters.
    if (classification.category === 'permanent_rejection') {
      console.error(
        `   ❌ [Job ${jobId}] Permanent SMTP rejection (${classification.responseCode || '5xx'}): ${safeErrorDescription}. Delivery marked 'failed'. Will not retry.`
      );

      await recordAttemptPermanentRejection(
        claimedDelivery.id,
        attemptId,
        classification,
        dbClient
      );

      await dbClient.query(
        "INSERT INTO email_logs (campaign_id, recipient_id, sender_id, status, error_message, sent_at) VALUES ($1, $2, $3, 'failed', $4, NULL)",
        [campaignId, recipientId, campaign.sender_id || null, `Permanent rejection: ${safeErrorDescription}`]
      );

      // Complete job cleanly WITHOUT rethrowing so BullMQ does not repeat permanent failures
      return;
    }

    // Outcome Categories 3 & 4: Transient rejection (4xx) or Connection failure confirmed before message acceptance
    // Invariant: Only retry failures confirmed to have occurred before SMTP acceptance
    const maxAttempts = job.opts?.attempts || 3;
    const isTransient = classification.category === 'transient_rejection';
    console.log(
      `   ⏳ [Job ${jobId}] ${isTransient ? 'Transient SMTP rejection' : 'Connection failure before message acceptance'} (${safeErrorDescription}). Safe to retry.`
    );

    if (isTransient) {
      await recordAttemptTransientRejection(
        claimedDelivery.id,
        attemptId,
        classification,
        claimedDelivery.attempt_count,
        maxAttempts,
        5000,
        dbClient
      );
    } else {
      await recordAttemptConnectionFailure(
        claimedDelivery.id,
        attemptId,
        classification,
        claimedDelivery.attempt_count,
        maxAttempts,
        5000,
        dbClient
      );
    }

    // Record in historical email_logs
    await dbClient.query(
      "INSERT INTO email_logs (campaign_id, recipient_id, sender_id, status, error_message, sent_at) VALUES ($1, $2, $3, 'failed', $4, NULL)",
      [campaignId, recipientId, campaign.sender_id || null, safeErrorDescription]
    );

    // Rethrow error so BullMQ can schedule exponential backoff retry for transient/connection failures
    throw smtpError;
  }

  // --- 7. Database Persistence Phase (Post-SMTP Acceptance Error Boundary) ---
  if (!smtpConfirmed || !sendResult) {
    return;
  }

  // Simulated missing response-code metadata for testing
  if (simulateNoResponseCode && config.app.nodeEnv !== 'production') {
    const rawQueued = sendResult.response?.match(/queued as\s+(<[^>\s]+>|[^\s]+)/i);
    sendResult.response = rawQueued
      ? `OK: queued as ${rawQueued[1]}`
      : 'OK: message queued for transmission';
  }

  // Extract genuine server message ID from SMTP response (e.g. queued as <...>) or client Message-ID
  const queuedAsMatch = sendResult.response ? sendResult.response.match(/queued as\s+(<[^>\s]+>|[^\s]+)/i) : null;
  const genuineMessageId = queuedAsMatch ? queuedAsMatch[1] : sendResult.messageId;

  // Genuine response code: extract from server response, or NULL if unavailable (never substitute fabricated '250')
  const responseCodeMatch = sendResult.response ? sendResult.response.match(/(?:^|\n)\s*([245]\d{2})\b/) : null;
  const genuineResponseCode = responseCodeMatch ? responseCodeMatch[1] : null;

  console.log(`   ✅ [Job ${jobId}] Email accepted by SMTP server! MessageId: ${genuineMessageId}`);

  try {
    // Simulated Database Persistence Failure for Testing
    if (simulateDbFailureAfterSend && config.app.nodeEnv !== 'production') {
      throw new Error('Simulated PostgreSQL connection failure immediately after SMTP acceptance.');
    }

    // Update canonical delivery and attempt to 'sent' with genuine messageId and genuine responseCode (null if unavailable)
    await recordAttemptSuccess(claimedDelivery.id, attemptId, genuineMessageId, dbClient, genuineResponseCode);

    // Record Success in historical email_logs
    await dbClient.query(
      `INSERT INTO email_logs (campaign_id, recipient_id, sender_id, status, error_message, sent_at)
       VALUES ($1, $2, $3, 'sent', NULL, NOW())`,
      [campaignId, recipientId, campaign.sender_id || null]
    );

    // Index in Elasticsearch (safely in background)
    if (process.env.DISABLE_ES_INDEXING !== 'true') {
      try {
        await indexEmailAsSent(campaign, recipient, new Date());
      } catch (esErr: any) {
        console.error(`❌ [Elasticsearch] Sent email indexing failed: ${esErr.message}`);
      }
    }

    // Check campaign completion status
    try {
      const remainingCheck = await dbClient.query(
        `SELECT COUNT(*) as remaining FROM email_deliveries ed
         WHERE ed.campaign_id = $1
           AND ed.deleted_at IS NULL
           AND ed.status != 'sent'`,
        [campaignId]
      );
      const remaining = parseInt(remainingCheck.rows[0]?.remaining || '1', 10);
      if (remaining === 0) {
        await dbClient.query("UPDATE campaigns SET status = 'completed', updated_at = NOW() WHERE id = $1", [
          campaignId,
        ]);
        console.log(`🎉 [Campaign ${campaignId}] All recipients processed. Campaign marked completed.`);

        try {
          await notifyCampaignCompleted(campaign.user_id, campaignId, campaign.subject);
        } catch (slackErr: any) {
          console.warn(`⚠️ [Slack] Failed to send completion notification: ${slackErr.message}`);
        }
      }
    } catch (statusErr: any) {
      console.warn(`⚠️ [Campaign ${campaignId}] Could not update status: ${statusErr.message}`);
    }
  } catch (dbErr: any) {
    // Invariant: Database persistence failed AFTER confirmed SMTP acceptance.
    // 1. DO NOT classify dbErr as an SMTP rejection or connection failure.
    // 2. DO NOT allow BullMQ to retry or resend the email.
    // 3. Mark delivery and attempt in safe uncertain/reconciliation state ('unknown').
    // 4. Preserve genuine message ID so duplicate dispatch is permanently blocked.
    console.error(
      `💥 [Job ${jobId}] Database persistence failed AFTER confirmed SMTP acceptance (MessageId: ${genuineMessageId}): ${dbErr.message}`
    );

    await recordPostgresPersistenceFailure(
      claimedDelivery.id,
      attemptId,
      genuineMessageId,
      genuineResponseCode,
      dbErr.message,
      dbClient
    );

    // Complete job cleanly WITHOUT rethrowing so BullMQ does NOT blindly re-execute the job and resend the email!
    return;
  }
}

export let worker: Worker<EmailJobPayload, void, string> | null = null;

// ---------------------------------------------------------------------------
// Event-Driven & Bounded Stale Delivery Reconciliation
// ---------------------------------------------------------------------------
let lastEventReconciliationMs = 0;
const MIN_RECONCILIATION_INTERVAL_MS = 10_000;

export async function maybeReconcileStaleDeliveries(dbClient = pool): Promise<void> {
  const now = Date.now();
  if (now - lastEventReconciliationMs < MIN_RECONCILIATION_INTERVAL_MS) {
    return;
  }
  lastEventReconciliationMs = now;
  try {
    const result = await reconcileStaleDeliveries(dbClient);
    if (result.reconciledCount > 0) {
      console.log(
        `⚠️  [EventReconciliation] Reconciled ${result.reconciledCount} stale in-flight delivery(ies) to 'unknown'`
      );
    }
  } catch (err: any) {
    console.warn(`⚠️ [EventReconciliation] Notice: ${err.message}`);
  }
}

export function createWorkerInstance(): Worker<EmailJobPayload, void, string> {
  const w = new Worker<EmailJobPayload, void, string>(
    emailQueueName,
    async (job: Job<EmailJobPayload>) => {
      await processEmailJob(job);
    },
    {
      connection: redisConnectionOptions,
      concurrency: workerConcurrency,
      autorun: false,
    }
  );

  w.on('completed', (job) => {
    console.log(`🟢 [Job ${job.id}] Successfully completed.`);
  });

  w.on('failed', (job, err) => {
    console.error(`🔴 [Job ${job?.id}] Failed with error: ${err.message}`);
  });

  w.on('error', (err) => {
    console.error(`❌ Worker error: ${err.message}`);
  });

  w.on('drained', async () => {
    await maybeReconcileStaleDeliveries(pool);
  });

  return w;
}

/**
 * Initializes and starts the worker with startup stale delivery reconciliation.
 * Executes reconcileStaleDeliveries() BEFORE normal job processing begins.
 */
export async function initializeWorker(dbClient = pool): Promise<Worker<EmailJobPayload, void, string> | null> {
  try {
    console.log('🔄 [Worker Startup] Running startup stale delivery reconciliation...');
    const result = await reconcileStaleDeliveries(dbClient);
    if (result.reconciledCount > 0) {
      console.log(
        `⚠️  [Worker Startup] Reconciled ${result.reconciledCount} stale in-flight delivery(ies) to 'unknown'`
      );
    } else {
      console.log('✅ [Worker Startup] Startup stale delivery check complete (0 stale deliveries).');
    }
  } catch (err: any) {
    console.error('❌ [Worker Startup] Stale delivery reconciliation error during startup:', err.message);
  }

  if (process.env.START_WORKER !== 'false') {
    if (!worker) {
      worker = createWorkerInstance();
    }
    worker.run();
    console.log('👷 BullMQ worker active and processing jobs.');
    return worker;
  }

  return null;
}

if (process.env.START_WORKER !== 'false') {
  initializeWorker().catch((err) => {
    console.error('❌ [Worker Startup] Failed to initialize worker:', err);
  });
}

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

async function shutdown() {
  console.log('\n⚠️  Shutting down worker gracefully...');
  if (worker) {
    await worker.close();
  }
  await pool.end();
  console.log('👋 Worker closed.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
