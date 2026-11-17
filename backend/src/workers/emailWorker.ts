import { Worker, Job, DelayedError } from 'bullmq';
import { emailQueueName, EmailJobPayload, redisConnectionOptions } from '../queue/emailQueue';
import { sendEmail } from '../services/emailService';
import { checkRateLimit, checkSenderRateLimit } from '../services/rateLimiter';
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
  recordAttemptFailure,
  recordAttemptUncertain,
  isUncertainSmtpError,
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
      testWindowSeconds?: number;
    };
    attemptsMade: number;
    opts?: { attempts?: number };
    token?: string;
    moveToDelayed?: (timestamp: number, token?: string) => Promise<void>;
  },
  dbClient = pool
): Promise<void> {
  const { campaignId, recipientId, simulateFailure, simulateUncertain, testWindowSeconds } = job.data;
  const attempt = job.attemptsMade + 1;
  const jobId = job.id || `direct_${Date.now()}`;

  console.log(`\n⏳ [Job ${jobId}] Attempt ${attempt}`);
  console.log(`   campaign=${campaignId}`);
  console.log(`   recipient=${recipientId}`);

  // --- 1. Load Campaign and Recipient ---
  const campaignResult = await dbClient.query<CampaignRow>(
    'SELECT * FROM campaigns WHERE id = $1',
    [campaignId]
  );
  const campaign = campaignResult.rows[0];

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
    leaseDurationMs: 60000,
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

  // --- 2.6. Campaign Rate Limit Check ---
  const windowSeconds =
    testWindowSeconds ||
    (process.env['RATE_LIMIT_WINDOW_SECONDS']
      ? parseInt(process.env['RATE_LIMIT_WINDOW_SECONDS'], 10)
      : config.app.rateLimitWindow);
  const { allowed, waitMs } = await checkRateLimit(campaignId, campaign.hourly_limit, windowSeconds);

  if (!allowed) {
    console.log(
      `   ⏳ [Job ${jobId}] Rate limit reached for campaign ${campaignId}. Delaying for ${waitMs}ms`
    );
    const delayMs = Math.max(waitMs, 1000);
    await releaseDeliveryClaim(claimedDelivery.id, 'retry_wait', delayMs, dbClient);
    await handleRateLimitNotification(campaignId, campaign.hourly_limit, waitMs);

    if (job.moveToDelayed) {
      await job.moveToDelayed(Date.now() + delayMs, job.token);
      throw new DelayedError();
    }
    return;
  }

  // --- 2.7. Shared Sender Rate Limit Check ---
  if (sender && sender.hourly_limit && sender.hourly_limit > 0) {
    const senderLimitCheck = await checkSenderRateLimit(sender.id, sender.hourly_limit, windowSeconds);
    if (!senderLimitCheck.allowed) {
      console.log(
        `   ⏳ [Job ${jobId}] Shared sender rate limit reached for sender ${sender.id}. Delaying for ${senderLimitCheck.waitMs}ms`
      );
      const delayMs = Math.max(senderLimitCheck.waitMs, 1000);
      await releaseDeliveryClaim(claimedDelivery.id, 'retry_wait', delayMs, dbClient);

      if (job.moveToDelayed) {
        await job.moveToDelayed(Date.now() + delayMs, job.token);
        throw new DelayedError();
      }
      return;
    }
  }

  // --- 3. Build Email Content ---
  const nameReplacement = recipient.name || 'there';
  const subject = campaign.subject.replace(/\{\{name\}\}/g, nameReplacement);
  const bodyText = campaign.body.replace(/\{\{name\}\}/g, nameReplacement);
  const bodyHtml = bodyText.replace(/\n/g, '<br>');

  // --- 4. Send Spacing Check ---
  const sendDelayMs = config.app.emailSendDelayMs;
  const { allowed: spacingAllowed, waitMs: spacingWaitMs } = await checkSendSpacing(sendDelayMs);

  if (!spacingAllowed) {
    console.log(`   [SendDelay] Email send delayed by ${spacingWaitMs}ms`);
    const delayMs = Math.max(spacingWaitMs, 10);
    await releaseDeliveryClaim(claimedDelivery.id, 'retry_wait', delayMs, dbClient);

    if (job.moveToDelayed) {
      await job.moveToDelayed(Date.now() + delayMs, job.token);
      throw new DelayedError();
    }
    return;
  }

  // --- 5. Record Attempt Start in email_attempts ---
  const attemptId = await recordAttemptStart(
    claimedDelivery.id,
    claimedDelivery.attempt_count,
    campaign.sender_id || null,
    dbClient
  );

  // --- 6. Send Email via Nodemailer ---
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
    const result = await sendEmail({
      sender: sender || undefined,
      to: recipient.email,
      subject,
      text: bodyText,
      html: bodyHtml,
    });

    console.log(`   ✅ [Job ${jobId}] Email sent successfully! MessageId: ${result.messageId}`);

    // Update canonical delivery and attempt to 'sent'
    await recordAttemptSuccess(claimedDelivery.id, attemptId, result.messageId, dbClient);

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
  } catch (error: any) {
    const safeErrorDescription = error.message || 'Unknown SMTP error';

    // Invariant: Never automatically retry an uncertain SMTP outcome
    if (isUncertainSmtpError(error)) {
      console.error(
        `   ⚠️ [Job ${jobId}] Uncertain SMTP outcome detected (${safeErrorDescription}). Marking as 'unknown'. Never blindly resending.`
      );

      await recordAttemptUncertain(
        claimedDelivery.id,
        attemptId,
        { message: safeErrorDescription, code: error.code },
        dbClient
      );

      // Record in historical email_logs as failed with uncertain detail
      await dbClient.query(
        "INSERT INTO email_logs (campaign_id, recipient_id, sender_id, status, error_message, sent_at) VALUES ($1, $2, $3, 'failed', $4, NULL)",
        [campaignId, recipientId, campaign.sender_id || null, `Uncertain outcome: ${safeErrorDescription}`]
      );

      // Complete job cleanly WITHOUT rethrowing to prevent BullMQ from auto-retrying
      return;
    }

    // Definite failure: Record attempt and update canonical delivery
    const maxAttempts = job.opts?.attempts || 3;
    await recordAttemptFailure(
      claimedDelivery.id,
      attemptId,
      { message: safeErrorDescription, code: error.code },
      claimedDelivery.attempt_count,
      maxAttempts,
      5000,
      dbClient
    );

    // Record in historical email_logs
    await dbClient.query(
      "INSERT INTO email_logs (campaign_id, recipient_id, sender_id, status, error_message, sent_at) VALUES ($1, $2, $3, 'failed', $4, NULL)",
      [campaignId, recipientId, campaign.sender_id || null, safeErrorDescription]
    );

    console.log(`   ⏳ [Job ${jobId}] Definite failure recorded. Rethrowing for BullMQ exponential backoff...`);
    throw error;
  }
}

export let worker: Worker<EmailJobPayload, void, string> | null = null;

if (process.env.START_WORKER !== 'false') {
  worker = new Worker<EmailJobPayload, void, string>(
    emailQueueName,
    async (job: Job<EmailJobPayload>) => {
      await processEmailJob(job);
    },
    {
      connection: redisConnectionOptions,
      concurrency: workerConcurrency,
    }
  );

  worker.on('completed', (job) => {
    console.log(`🟢 [Job ${job.id}] Successfully completed.`);
  });

  worker.on('failed', (job, err) => {
    console.error(`🔴 [Job ${job?.id}] Failed with error: ${err.message}`);
  });

  worker.on('error', (err) => {
    console.error(`❌ Worker error: ${err.message}`);
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
