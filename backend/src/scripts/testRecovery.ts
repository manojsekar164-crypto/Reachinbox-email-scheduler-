import { Worker, Job, DelayedError, Queue } from 'bullmq';
import { db as pool } from '../db/postgres';
import { redisConnectionOptions, EmailJobPayload } from '../queue/emailQueue';
import { sendEmail } from '../services/emailService';
import { checkRateLimit } from '../services/rateLimiter';
import { CampaignRow, RecipientRow } from '../types/db.types';

/**
 * src/scripts/testRecovery.ts
 *
 * Demonstrates persistence across worker restarts.
 * It uses a dedicated test queue to avoid conflict with running dev workers.
 * It manually spins up a worker, hits the rate limit (delaying a job),
 * kills the worker, and spins up a new one to prove the job survives in Redis.
 */

const testQueueName = 'recovery-queue-test';
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

      const { allowed, waitMs } = await checkRateLimit(campaignId, campaign.hourly_limit, 20); // 20 seconds window
      if (!allowed) {
        const delayMs = Math.max(waitMs, 1000);
        await job.moveToDelayed(Date.now() + delayMs, job.token);
        throw new DelayedError();
      }

      const recipientResult = await pool.query<RecipientRow>('SELECT * FROM recipients WHERE id = $1', [recipientId]);
      
      await sendEmail({
        to: recipientResult.rows[0].email,
        subject: 'Recovery Test',
        text: 'Recovery text',
        html: '<p>Recovery</p>',
      });

      await pool.query(
        "INSERT INTO email_logs (campaign_id, recipient_id, status, error_message, sent_at) VALUES ($1, $2, 'sent', NULL, NOW())",
        [campaignId, recipientId]
      );
    },
    { connection: redisConnectionOptions, concurrency: 1 }
  );
  return worker;
}

async function main() {
  console.log('🧪 Starting Recovery / Restart Tests...\n');

  try {
    // 1. Setup Test Data (Limit = 1)
    const userRes = await pool.query(
      `INSERT INTO users (email, name) VALUES ('test-recovery@example.com', 'Recovery User') 
       ON CONFLICT (email) DO UPDATE SET name = 'Recovery User' RETURNING id`
    );
    const campaignRes = await pool.query(
      `INSERT INTO campaigns (user_id, subject, body, hourly_limit, status) 
       VALUES ($1, 'Recovery Subject', 'Body', 1, 'sending') RETURNING id`,
      [userRes.rows[0].id]
    );
    const campaignId = campaignRes.rows[0].id;

    const rec1 = await pool.query(
      `INSERT INTO recipients (campaign_id, email, name, status) VALUES ($1, 'rec1@example.com', 'R1', 'pending') RETURNING id`,
      [campaignId]
    );
    const rec2 = await pool.query(
      `INSERT INTO recipients (campaign_id, email, name, status) VALUES ($1, 'rec2@example.com', 'R2', 'pending') RETURNING id`,
      [campaignId]
    );

    // 2. Start initial worker
    console.log('👷 Starting initial worker (Worker A)...');
    let workerA = await createWorker();

    // 3. Add jobs to test queue
    await testQueue.add('send-email', { campaignId, recipientId: rec1.rows[0].id });
    const job2 = await testQueue.add('send-email', { campaignId, recipientId: rec2.rows[0].id });

    console.log('⏳ Waiting 10 seconds for Job 1 to succeed and Job 2 to be delayed...');
    await delay(10000);

    const state2 = await job2.getState();
    if (state2 === 'delayed') {
      console.log('✅ PASS: Job 2 is successfully delayed due to rate limit.');
    } else {
      console.error(`❌ FAIL: Job 2 should be delayed, but is ${state2}.`);
    }

    // 4. Kill worker
    console.log('\n🛑 Stopping initial worker (simulating API/Worker restart)...');
    await workerA.close();
    console.log('✅ PASS: Worker stopped.');

    const state2AfterKill = await job2.getState();
    console.log(`✅ PASS: Job 2 still exists in Redis. State: ${state2AfterKill}`);

    console.log('⏳ Waiting 12 seconds (passing the 20s rate limit window while worker is dead)...');
    await delay(12000);

    // 5. Restart worker
    console.log('\n👷 Starting new worker (Worker B)...');
    let workerB = await createWorker();
    console.log('✅ PASS: Worker restarted.');

    console.log('⏳ Waiting 10 seconds for new worker to pick up delayed job...');
    await delay(10000);

    const finalState2 = await job2.getState();
    if (finalState2 === 'completed') {
      console.log('✅ PASS: Job 2 processed successfully after restart.');
    } else {
      console.error(`❌ FAIL: Job 2 state is ${finalState2}, expected completed.`);
    }

    const logs = await pool.query("SELECT id FROM email_logs WHERE campaign_id = $1 AND status = 'sent'", [campaignId]);
    if (logs.rows.length === 2) {
      console.log('✅ PASS: email_logs contains both successful sends.');
    } else {
      console.error(`❌ FAIL: expected 2 logs, got ${logs.rows.length}`);
    }

    await workerB.close();
    console.log('\n🎉 Recovery tests finished.');

  } catch (err) {
    console.error('❌ Recovery test failed:', err);
  } finally {
    console.log('🧹 Cleaning up connections...');
    await testQueue.close();
    await pool.end();
    process.exit(0);
  }
}

main();
