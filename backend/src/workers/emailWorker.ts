import { Worker, Job, DelayedError } from 'bullmq';
import { emailQueueName, EmailJobPayload, redisConnectionOptions } from '../queue/emailQueue';
import { sendEmail } from '../services/emailService';
import { checkRateLimit } from '../services/rateLimiter';
import { handleRateLimitNotification } from '../services/slackService';
import { indexEmailAsSent } from '../services/searchService';
import { db as pool } from '../db/postgres';
import { CampaignRow, RecipientRow } from '../types/db.types';
import { config } from '../config';
import { getSenderByIdInternal } from '../services/senderService';
import { checkSendSpacing } from '../services/sendSpacing';

/**
 * src/workers/emailWorker.ts
 *
 * BullMQ Worker for processing email jobs.
 * This runs independently from the HTTP API.
 */

console.log(`👷 Starting worker for queue: ${emailQueueName}`);
console.log(`⚙️  Concurrency: 2`);

export const worker = new Worker<EmailJobPayload, void, string>(
  emailQueueName,
  async (job: Job<EmailJobPayload>) => {
    const { campaignId, recipientId, simulateFailure, testWindowSeconds } = job.data as EmailJobPayload & { simulateFailure?: boolean, testWindowSeconds?: number };
    
    // In BullMQ, job.attemptsMade starts at 0 for the first attempt during execution.
    const attempt = job.attemptsMade + 1;
    
    console.log(`\n⏳ [Job ${job.id}] Attempt ${attempt}`);
    console.log(`   campaign=${campaignId}`);
    console.log(`   recipient=${recipientId}`);

    // --- 1. Load Campaign and Recipient ---
    const campaignResult = await pool.query<CampaignRow>(
      'SELECT * FROM campaigns WHERE id = $1',
      [campaignId]
    );
    const campaign = campaignResult.rows[0];

    const recipientResult = await pool.query<RecipientRow>(
      'SELECT * FROM recipients WHERE id = $1',
      [recipientId]
    );
    const recipient = recipientResult.rows[0];

    if (!campaign || !recipient) {
      throw new Error(`Job missing DB records: campaignId=${campaignId}, recipientId=${recipientId}`);
    }

    // --- 1.5. Load and Verify Sender if configured ---
    let sender = null;
    if (campaign.sender_id) {
      sender = await getSenderByIdInternal(campaign.sender_id);
      if (!sender) {
        throw new Error(`Job missing DB records: senderId=${campaign.sender_id} referenced by campaignId=${campaignId}`);
      }
      if (sender.user_id !== campaign.user_id) {
        throw new Error(`Security validation failed: Sender user_id ${sender.user_id} does not match campaign user_id ${campaign.user_id}.`);
      }
    }

    // --- 2. Idempotency Check ---
    const sentCheck = await pool.query(
      "SELECT id FROM email_logs WHERE campaign_id = $1 AND recipient_id = $2 AND status = 'sent' LIMIT 1",
      [campaignId, recipientId]
    );
    
    if (sentCheck.rows.length > 0) {
      console.log(`   ⏭️ [Job ${job.id}] Idempotency check: Already sent successfully. Skipping.`);
      return; // Job succeeds immediately without sending again
    }

    // --- 2.5. Rate Limit Check ---
    const windowSeconds =
      testWindowSeconds ||
      (process.env['RATE_LIMIT_WINDOW_SECONDS']
        ? parseInt(process.env['RATE_LIMIT_WINDOW_SECONDS'], 10)
        : config.app.rateLimitWindow);
    const { allowed, waitMs } = await checkRateLimit(campaignId, campaign.hourly_limit, windowSeconds);

    if (!allowed) {
      console.log(`   ⏳ [Job ${job.id}] Rate limit reached for campaign ${campaignId}. Delaying for ${waitMs}ms`);
      
      // Trigger Slack notification (errors are internally handled and isolated)
      await handleRateLimitNotification(campaignId, campaign.hourly_limit, waitMs);

      // Delaying the job moves it back to delayed state without consuming an attempt
      const delayMs = Math.max(waitMs, 1000);
      await job.moveToDelayed(Date.now() + delayMs, job.token);
      throw new DelayedError();
    }

    // --- 3. Build Email Content ---
    const nameReplacement = recipient.name || 'there';
    const subject = campaign.subject.replace(/\{\{name\}\}/g, nameReplacement);
    const bodyText = campaign.body.replace(/\{\{name\}\}/g, nameReplacement);
    
    // For HTML, safely replace newlines with <br> tags. We assume campaign.body is plain text.
    const bodyHtml = bodyText.replace(/\n/g, '<br>');

    // --- 4. Simulate Failure if requested (for testing retry behavior) ---
    if (simulateFailure && attempt === 1) {
      console.log(`   💥 [Job ${job.id}] Intentional test failure`);
      console.log(`   ⏳ [Job ${job.id}] Retrying`);
      const errorMsg = 'Simulated processing failure for testing retries.';
      
      // Log the failure
      await pool.query(
        'INSERT INTO email_logs (campaign_id, recipient_id, sender_id, status, error_message, sent_at) VALUES ($1, $2, $3, $4, $5, NULL)',
        [campaignId, recipientId, campaign.sender_id || null, 'failed', errorMsg]
      );
      throw new Error(errorMsg);
    }

    // --- 4.5. Send Spacing Check ---
    const sendDelayMs = config.app.emailSendDelayMs;
    const { allowed: spacingAllowed, waitMs: spacingWaitMs } = await checkSendSpacing(sendDelayMs);

    if (!spacingAllowed) {
      console.log(`   [SendDelay] minimumDelayMs=${sendDelayMs} remainingDelayMs=${spacingWaitMs}`);
      console.log(`   [SendDelay] Email send delayed by ${spacingWaitMs}ms`);
      const delayMs = Math.max(spacingWaitMs, 10);
      await job.moveToDelayed(Date.now() + delayMs, job.token);
      throw new DelayedError();
    }

    if (sendDelayMs > 0) {
      console.log(`   [SendDelay] Send slot acquired`);
    }

    // --- 5. Send Email via Nodemailer ---
    try {
      console.log(`   ✉️ [Job ${job.id}] Sending email via Nodemailer...`);
      const result = await sendEmail({
        sender: sender || undefined,
        to: recipient.email,
        subject,
        text: bodyText,
        html: bodyHtml,
      });

      console.log(`   ✅ [Job ${job.id}] Email sent successfully! MessageId: ${result.messageId}`);
      if (result.previewUrl) {
        console.log(`   👀 Ethereal Preview: ${result.previewUrl}`);
      }

      // Record Success
      await pool.query(
        "INSERT INTO email_logs (campaign_id, recipient_id, sender_id, status, error_message, sent_at) VALUES ($1, $2, $3, 'sent', NULL, NOW())",
        [campaignId, recipientId, campaign.sender_id || null]
      );

      // Index in Elasticsearch (safely in background, catching all errors)
      try {
        await indexEmailAsSent(campaign, recipient, new Date());
      } catch (esErr: any) {
        console.error(`❌ [Elasticsearch] Sent email indexing failed: ${esErr.message}`);
      }

      // Update campaign status if all recipients have been delivered
      try {
        const remainingCheck = await pool.query(
          `SELECT COUNT(*) as remaining FROM recipients r
           WHERE r.campaign_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM email_logs el WHERE el.campaign_id = $1 AND el.recipient_id = r.id AND el.status = 'sent'
           )`,
          [campaignId]
        );
        const remaining = parseInt(remainingCheck.rows[0]?.remaining || '1', 10);
        if (remaining === 0) {
          await pool.query("UPDATE campaigns SET status = 'completed', updated_at = NOW() WHERE id = $1", [campaignId]);
          console.log(`🎉 [Campaign ${campaignId}] All recipients processed. Campaign marked completed.`);
        } else {
          await pool.query("UPDATE campaigns SET status = 'sending', updated_at = NOW() WHERE id = $1 AND status != 'sending'", [campaignId]);
        }
      } catch (statusErr: any) {
        console.warn(`⚠️ [Campaign ${campaignId}] Could not update status: ${statusErr.message}`);
      }
      
    } catch (error: any) {
      // --- 6. Handle Send Failure ---
      console.error(`   ❌ [Job ${job.id}] Nodemailer send failed:`, error.message);
      
      const safeErrorDescription = error.message || 'Unknown SMTP error';
      await pool.query(
        "INSERT INTO email_logs (campaign_id, recipient_id, sender_id, status, error_message, sent_at) VALUES ($1, $2, $3, 'failed', $4, NULL)",
        [campaignId, recipientId, campaign.sender_id || null, safeErrorDescription]
      );

      console.log(`   ⏳ [Job ${job.id}] Rethrowing to allow BullMQ to retry...`);
      throw error; // Rethrow to let BullMQ handle the backoff/retry
    }
  },
  {
    connection: redisConnectionOptions,
    concurrency: 2, // Process up to 2 jobs concurrently
  }
);

// ---------------------------------------------------------------------------
// Worker Event Listeners
// ---------------------------------------------------------------------------

worker.on('completed', (job) => {
  console.log(`🟢 [Job ${job.id}] Successfully completed.`);
});

worker.on('failed', (job, err) => {
  console.error(`🔴 [Job ${job?.id}] Failed with error: ${err.message}`);
});

worker.on('error', (err) => {
  console.error(`❌ Worker error: ${err.message}`);
});

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

async function shutdown() {
  console.log('\n⚠️  Shutting down worker gracefully...');
  await worker.close();
  // Do not close the pool here unless we are sure nothing else is using it,
  // but since this is a dedicated worker process, it's safe to close.
  await pool.end();
  console.log('👋 Worker closed.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
