import { Worker, Job, DelayedError, Queue } from 'bullmq';
import { db as pool } from '../db/postgres';
import { redisConnectionOptions, EmailJobPayload } from '../queue/emailQueue';
import { checkRateLimit } from '../services/rateLimiter';
import { sendEmail } from '../services/emailService';
import { handleRateLimitNotification, testState, clearTestState } from '../services/slackService';
import { saveSlackIntegration } from '../services/slackIntegrationService';
import { CampaignRow, RecipientRow } from '../types/db.types';
import dotenv from 'dotenv';
import path from 'path';

// Ensure .env is loaded
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const testQueueName = 'slack-integration-queue-test';
const testQueue = new Queue(testQueueName, { connection: redisConnectionOptions });

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls job states until the expected number of completed and delayed jobs is reached.
 * Avoids timing race conditions during queue processing.
 */
async function waitForInitialRateLimitState(
  jobs: Job[],
  expectedCompleted: number,
  expectedDelayed: number
): Promise<string[]> {
  const timeoutMs = 40000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const states = await Promise.all(jobs.map((j) => j.getState()));
    const completed = states.filter((s) => s === 'completed' || s === 'unknown').length;
    const delayed = states.filter((s) => s === 'delayed').length;
    if (completed === expectedCompleted && delayed === expectedDelayed) {
      return states;
    }
    await delay(500);
  }
  return Promise.all(jobs.map((j) => j.getState()));
}

/**
 * Polls job states until all jobs in the list have completed successfully.
 */
async function waitForAllCompleted(jobs: Job[]): Promise<boolean> {
  const timeoutMs = 40000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const states = await Promise.all(jobs.map((j) => j.getState()));
    const completed = states.filter((s) => s === 'completed' || s === 'unknown').length;
    if (completed === jobs.length) {
      return true;
    }
    await delay(500);
  }
  return false;
}

async function createWorker() {
  const worker = new Worker<EmailJobPayload, void, string>(
    testQueueName,
    async (job: Job<EmailJobPayload>) => {
      const { campaignId, recipientId } = job.data;

      // Load records
      const campaignResult = await pool.query<CampaignRow>('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
      const campaign = campaignResult.rows[0];

      // Idempotency check
      const sentCheck = await pool.query(
        "SELECT id FROM email_logs WHERE campaign_id = $1 AND recipient_id = $2 AND status = 'sent' LIMIT 1",
        [campaignId, recipientId]
      );
      if (sentCheck.rows.length > 0) return;

      // Rate limit check - using a 40-second window for deterministic testing
      const { allowed, waitMs } = await checkRateLimit(campaignId, campaign.hourly_limit, 40);
      if (!allowed) {
        // Trigger Slack notifications using the shared service handler
        await handleRateLimitNotification(campaignId, campaign.hourly_limit, waitMs);

        const delayMs = Math.max(waitMs, 1000);
        await job.moveToDelayed(Date.now() + delayMs, job.token);
        throw new DelayedError();
      }

      // Simulate sending email
      const recipientResult = await pool.query<RecipientRow>('SELECT * FROM recipients WHERE id = $1', [recipientId]);
      const recipient = recipientResult.rows[0];

      await sendEmail({
        to: recipient.email,
        subject: campaign.subject,
        text: 'Integration test body.',
        html: '<p>Integration test body.</p>',
      });

      // Log success
      await pool.query(
        "INSERT INTO email_logs (campaign_id, recipient_id, status, error_message, sent_at) VALUES ($1, $2, 'sent', NULL, NOW())",
        [campaignId, recipientId]
      );
    },
    { connection: redisConnectionOptions, concurrency: 2 }
  );

  return worker;
}

async function setupTestData(limit: number, recipientCount: number, suffix: string) {
  // Create mock user
  const userRes = await pool.query(
    `INSERT INTO users (email, name) VALUES ('test-slack-${suffix}@example.com', 'Slack Test User ${suffix}') 
     ON CONFLICT (email) DO UPDATE SET name = 'Slack Test User ${suffix}' RETURNING id`
  );
  const userId = userRes.rows[0].id;

  // Create mock Slack Integration (Phase 9D multi-tenant requirement)
  await saveSlackIntegration({
    userId,
    teamId: `T-SLACK-${suffix}`,
    teamName: `Slack Team ${suffix}`,
    accessToken: `xoxb-mock-token-${suffix}`,
    channelId: `C-SLACK-${suffix}`,
    channelName: `#channel-${suffix}`,
    webhookUrl: process.env.SLACK_WEBHOOK_URL || 'https://hooks.slack.com/services/T/B/mock',
    scope: 'incoming-webhook',
  });

  // Create mock campaign
  const campaignRes = await pool.query(
    `INSERT INTO campaigns (user_id, subject, body, hourly_limit, status) 
     VALUES ($1, $2, 'Slack integration test body.', $3, 'sending') 
     RETURNING id`,
    [userId, `Campaign Subject ${suffix}`, limit]
  );
  const campaignId = campaignRes.rows[0].id;

  // Create mock recipients
  const recipientIds: string[] = [];
  for (let i = 1; i <= recipientCount; i++) {
    const rec = await pool.query(
      `INSERT INTO recipients (campaign_id, email, name, status) 
       VALUES ($1, $2, $3, 'pending') 
       RETURNING id`,
      [campaignId, `recipient-${suffix}-${i}@example.com`, `Recipient ${i}`]
    );
    recipientIds.push(rec.rows[0].id);
  }

  return { campaignId, recipientIds };
}

async function runTests() {
  console.log('🧪 Starting ReachInbox Slack Integration Test Suite...\n');
  
  // Clean up any remaining jobs in the test queue
  await testQueue.drain();
  
  const originalWebhook = process.env.SLACK_WEBHOOK_URL;
  const worker = await createWorker();

  try {
    // =========================================================================
    // TEST 1: Rate Limit + Slack Integration & Deduplication Test
    // =========================================================================
    console.log('--- TEST 1: Rate Limit, Slack Alert & Notification Deduplication ---');
    clearTestState();

    const { campaignId: c1, recipientIds: r1 } = await setupTestData(2, 3, 'dedup');
    console.log(`Created Campaign: ${c1} with Limit = 2 and 3 Recipients.`);

    console.log('Adding 3 jobs to the queue...');
    const jobs1 = await Promise.all(
      r1.map((id) => testQueue.add('send-email', { campaignId: c1, recipientId: id }))
    );

    console.log('⏳ Waiting for initial processing (expect 2 completed, 1 delayed)...');
    const initialStates1 = await waitForInitialRateLimitState(jobs1, 2, 1);
    console.log(`Initial Job States: ${initialStates1.map((s, idx) => `[${idx+1}] ${s}`).join(', ')}`);

    const allowedSends1 = initialStates1.filter((s) => s === 'completed' || s === 'unknown' || s === 'active').length;
    const delayed1 = initialStates1.filter((s) => s === 'delayed').length;

    console.log(`Verification:`);
    if (allowedSends1 === 2) {
      console.log('  ✅ PASS: limit enforced, exactly 2 email send slots acquired initially');
    } else {
      console.error(`  ❌ FAIL: expected 2 allowed send slots, got ${allowedSends1}`);
    }

    if (delayed1 === 1) {
      console.log('  ✅ PASS: remaining 1 email delayed successfully');
    } else {
      console.error(`  ❌ FAIL: expected 1 delayed, got ${delayed1}`);
    }

    // Verify Slack Notifications triggered and deduplicated
    console.log(`Slack Notifications sent in Test 1: ${testState.sentNotifications.length}`);
    if (testState.sentNotifications.length === 1) {
      console.log('  ✅ PASS: exactly 1 Slack rate-limit alert sent (no duplicate spam)');
      const alert = testState.sentNotifications[0].text;
      if (
        alert.includes('ReachInbox Rate Limit Alert') &&
        alert.includes('Campaign Subject dedup') &&
        alert.includes(c1) &&
        alert.includes('*Limit:* 2') &&
        alert.includes('Reset in:')
      ) {
        console.log('  ✅ PASS: Slack alert message format is correct and contains expected details');
      } else {
        console.error('  ❌ FAIL: Slack alert message details or format are incorrect:', alert);
      }
    } else {
      console.error(`  ❌ FAIL: expected exactly 1 Slack notification, got ${testState.sentNotifications.length}`);
    }

    // Wait for rate-limit window to reset and all jobs to complete
    console.log('⏳ Waiting for rate limit window reset and job retries (approx 10-15s)...');
    const allCompleted1 = await waitForAllCompleted(jobs1);
    
    const finalStates1 = await Promise.all(jobs1.map((j) => j.getState()));
    console.log(`Final Job States: ${finalStates1.map((s, idx) => `[${idx+1}] ${s}`).join(', ')}`);

    if (allCompleted1) {
      console.log('  ✅ PASS: delayed email jobs resumed and completed successfully');
    } else {
      console.error(`  ❌ FAIL: expected all 3 jobs to complete, but some did not.`);
    }

    const logsCount1 = await pool.query(
      "SELECT count(*) FROM email_logs WHERE campaign_id = $1 AND status = 'sent'",
      [c1]
    );
    if (parseInt(logsCount1.rows[0].count, 10) === 3) {
      console.log('  ✅ PASS: exactly 3 successful sends recorded in email_logs');
    } else {
      console.error(`  ❌ FAIL: expected 3 logs, got ${logsCount1.rows[0].count}`);
    }

    console.log('\n=========================================================================\n');

    // =========================================================================
    // TEST 2: Slack Failure Isolation Test
    // =========================================================================
    console.log('--- TEST 2: Slack Failure Isolation ---');
    clearTestState();

    // Set an invalid webhook URL to force HTTP call failures
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T0000/B0000/invalid-url-for-failure-test';
    console.log(`Configured invalid webhook URL (mocking network/invalid webhook failure)`);

    const { campaignId: c2, recipientIds: r2 } = await setupTestData(2, 3, 'failure-isolation');
    console.log(`Created Campaign: ${c2} with Limit = 2 and 3 Recipients.`);

    console.log('Adding 3 jobs to the queue...');
    const jobs2 = await Promise.all(
      r2.map((id) => testQueue.add('send-email', { campaignId: c2, recipientId: id }))
    );

    console.log('⏳ Waiting for processing (expect 2 completed, 1 delayed)...');
    const states2 = await waitForInitialRateLimitState(jobs2, 2, 1);
    console.log(`Job States with broken Slack webhook: ${states2.map((s, idx) => `[${idx+1}] ${s}`).join(', ')}`);

    const completed2 = states2.filter((s) => s === 'completed' || s === 'unknown').length;
    const delayed2 = states2.filter((s) => s === 'delayed').length;
    const failed2 = states2.filter((s) => s === 'failed').length;

    console.log(`Verification:`);
    if (completed2 === 2) {
      console.log('  ✅ PASS: 2 emails sent successfully');
    } else {
      console.error(`  ❌ FAIL: expected 2 completed, got ${completed2}`);
    }

    if (delayed2 === 1) {
      console.log('  ✅ PASS: 3rd email delayed successfully due to rate limit');
    } else {
      console.error(`  ❌ FAIL: expected 1 delayed, got ${delayed2}`);
    }

    if (failed2 === 0) {
      console.log('  ✅ PASS: no jobs marked failed due to Slack failure (Slack failure is fully isolated!)');
    } else {
      console.error(`  ❌ FAIL: detected ${failed2} failed jobs, indicating Slack errors bubbled up!`);
    }

  } catch (error) {
    console.error('❌ Integration test suite crashed:', error);
  } finally {
    // Restore environment
    process.env.SLACK_WEBHOOK_URL = originalWebhook;
    console.log('\n🧹 Cleaning up connections and closing worker...');
    await worker.close();
    await testQueue.close();
    await pool.end();
    console.log('🎉 Slack Integration tests finished.');
    process.exit(0);
  }
}

runTests();
