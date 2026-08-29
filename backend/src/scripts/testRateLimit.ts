import { Worker, Job, DelayedError, Queue } from 'bullmq';
import { db as pool } from '../db/postgres';
import { redisConnectionOptions, EmailJobPayload } from '../queue/emailQueue';
import { sendEmail } from '../services/emailService';
import { checkRateLimit } from '../services/rateLimiter';
import { CampaignRow, RecipientRow } from '../types/db.types';

/**
 * src/scripts/testRateLimit.ts
 *
 * Verifies that the atomic Redis rate limiting properly delays jobs
 * and resumes them without duplicate sends.
 */

const testQueueName = 'rate-limit-queue-test';
const testQueue = new Queue(testQueueName, { connection: redisConnectionOptions });

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createWorker() {
  const worker = new Worker<EmailJobPayload, void, string>(
    testQueueName,
    async (job: Job<EmailJobPayload>) => {
      const { campaignId, recipientId } = job.data;
      
      const campaignResult = await pool.query<CampaignRow>('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
      const campaign = campaignResult.rows[0];

      const sentCheck = await pool.query(
        "SELECT id FROM email_logs WHERE campaign_id = $1 AND recipient_id = $2 AND status = 'sent' LIMIT 1",
        [campaignId, recipientId]
      );
      if (sentCheck.rows.length > 0) return;

      const { allowed, waitMs } = await checkRateLimit(campaignId, campaign.hourly_limit, 15); // 15 seconds window
      if (!allowed) {
        const delayMs = Math.max(waitMs, 1000);
        await job.moveToDelayed(Date.now() + delayMs, job.token);
        throw new DelayedError();
      }

      const recipientResult = await pool.query<RecipientRow>('SELECT * FROM recipients WHERE id = $1', [recipientId]);
      
      await sendEmail({
        to: recipientResult.rows[0].email,
        subject: 'Rate Limit Test Subject',
        text: 'Rate limit body.',
        html: '<p>Rate limit body.</p>',
      });

      await pool.query(
        "INSERT INTO email_logs (campaign_id, recipient_id, status, error_message, sent_at) VALUES ($1, $2, 'sent', NULL, NOW())",
        [campaignId, recipientId]
      );
    },
    { connection: redisConnectionOptions, concurrency: 2 }
  );
  return worker;
}

async function main() {
  console.log('🧪 Starting Rate Limit Tests...\n');

  try {
    console.log('🔄 Setting up rate-limit test data (Limit = 2)...');
    
    // Create a mock user
    const userRes = await pool.query(
      `INSERT INTO users (email, name) VALUES ('test-ratelimit@example.com', 'Rate Limit User') 
       ON CONFLICT (email) DO UPDATE SET name = 'Rate Limit User' RETURNING id`
    );
    const userId = userRes.rows[0].id;

    // Create a mock campaign with hourly_limit = 2
    const campaignRes = await pool.query(
      `INSERT INTO campaigns (user_id, subject, body, hourly_limit, status) 
       VALUES ($1, 'Rate Limit Test Subject', 'Rate limit body.', 2, 'sending') 
       RETURNING id`,
      [userId]
    );
    const campaignId = campaignRes.rows[0].id;

    // Create 3 mock recipients
    const recipients = [];
    for (let i = 1; i <= 3; i++) {
      const rec = await pool.query(
        `INSERT INTO recipients (campaign_id, email, name, status) 
         VALUES ($1, $2, $3, 'pending') 
         RETURNING id`,
        [campaignId, `recipient${i}@example.com`, `Recipient ${i}`]
      );
      recipients.push(rec.rows[0].id);
    }

    console.log(`✅ Test data created. Campaign ID: ${campaignId}`);

    console.log('👷 Starting local test worker...');
    const worker = await createWorker();

    console.log('📦 Adding 3 jobs to the queue concurrently...');
    const jobs = await Promise.all([
      testQueue.add('send-email', { campaignId, recipientId: recipients[0] }),
      testQueue.add('send-email', { campaignId, recipientId: recipients[1] }),
      testQueue.add('send-email', { campaignId, recipientId: recipients[2] }),
    ]);

    // Give the worker time to process the first 2 and delay the 3rd
    console.log('⏳ Waiting 10 seconds for initial processing...');
    await delay(10000);

    const initialStates = await Promise.all(jobs.map((j) => j.getState()));
    console.log(`Initial Job States: [1] ${initialStates[0]}, [2] ${initialStates[1]}, [3] ${initialStates[2]}`);

    const completedCount = initialStates.filter((s) => s === 'completed').length;
    const delayedCount = initialStates.filter((s) => s === 'delayed').length;

    if (completedCount === 2) {
      console.log('✅ PASS: limit enforced, exactly 2 emails sent initially');
    } else {
      console.error(`❌ FAIL: expected 2 completed, got ${completedCount}`);
    }

    if (delayedCount === 1) {
      console.log('✅ PASS: 3rd email delayed successfully');
    } else {
      console.error(`❌ FAIL: expected 1 delayed, got ${delayedCount}`);
    }

    // Now wait for the window to reset (15 seconds total window, we already waited 10) and poll for completion
    console.log('⏳ Waiting for rate limit window to reset and 3rd job to complete...');
    let finalStates = await Promise.all(jobs.map((j) => j.getState()));
    for (let i = 0; i < 25; i++) {
      await delay(1000);
      finalStates = await Promise.all(jobs.map((j) => j.getState()));
      const completedNow = finalStates.filter((s) => s === 'completed').length;
      if (completedNow === 3) break;
    }
    console.log(`Final Job States: [1] ${finalStates[0]}, [2] ${finalStates[1]}, [3] ${finalStates[2]}`);

    const finalCompletedCount = finalStates.filter((s) => s === 'completed').length;

    if (finalCompletedCount === 3) {
      console.log('✅ PASS: delayed email sent after reset');
    } else {
      console.error(`❌ FAIL: expected 3 completed, got ${finalCompletedCount}`);
    }

    // Verify email_logs
    const logs = await pool.query(
      "SELECT id FROM email_logs WHERE campaign_id = $1 AND status = 'sent'",
      [campaignId]
    );

    if (logs.rows.length === 3) {
      console.log('✅ PASS: 3 successful sends recorded in email_logs');
      console.log('✅ PASS: no email lost, no duplicate successful sends');
    } else {
      console.error(`❌ FAIL: expected 3 successful sends, got ${logs.rows.length}`);
    }

    console.log('\n🎉 Rate Limit tests finished.');
    await worker.close();

  } catch (err) {
    console.error('❌ Rate limit test failed:', err);
  } finally {
    console.log('🧹 Cleaning up connections...');
    await testQueue.close();
    await pool.end();
    process.exit(0);
  }
}

main();
