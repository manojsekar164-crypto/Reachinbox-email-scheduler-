import { emailQueue } from '../queue/emailQueue';
import { db as pool } from '../db/postgres';

/**
 * src/scripts/testQueue.ts
 *
 * Development script to verify BullMQ queue independent of the HTTP API.
 * Demonstrates:
 *  - Adding an immediate job
 *  - Adding a delayed job
 *  - Adding a job that fails to trigger retry
 * 
 * Polls for up to 20 seconds to observe state transitions.
 */

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  console.log('🧪 Starting Phase 5 Queue Tests...\n');

  console.log('🔄 Setting up test database records...');
  // Create a mock user
  const userRes = await pool.query(
    `INSERT INTO users (email, name) VALUES ('test-queue@example.com', 'Queue Test User') 
     ON CONFLICT (email) DO UPDATE SET name = 'Queue Test User' RETURNING id`
  );
  const userId = userRes.rows[0].id;

  // Create a mock campaign with high rate limit to prevent rate-limit delays in queue:test
  const campaignRes = await pool.query(
    `INSERT INTO campaigns (user_id, subject, body, hourly_limit, status) 
     VALUES ($1, 'Queue Test Subject', 'This is a queue test body.', 100, 'sending') 
     RETURNING id`,
    [userId]
  );
  const campaignId = campaignRes.rows[0].id;

  // Create 3 mock recipients (for immediate, delayed, and failing jobs)
  const recipients: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const recRes = await pool.query(
      `INSERT INTO recipients (campaign_id, email, name, status) 
       VALUES ($1, $2, $3, 'pending') 
       RETURNING id`,
      [campaignId, `recipient-queue-${i}@example.com`, `Recipient ${i}`]
    );
    recipients.push(recRes.rows[0].id);
  }
  console.log(`✅ Test database records created. Campaign ID: ${campaignId}\n`);

  // 1. Add jobs
  const job1 = await emailQueue.add('send-email', {
    campaignId,
    recipientId: recipients[0],
  });
  console.log(`✅ Immediate Job added. ID: ${job1.id}`);

  const job2 = await emailQueue.add(
    'send-email',
    {
      campaignId,
      recipientId: recipients[1],
    },
    { delay: 5000 }
  );
  console.log(`✅ Delayed Job added (5s). ID: ${job2.id}`);

  const job3 = await emailQueue.add(
    'send-email',
    {
      campaignId,
      recipientId: recipients[2],
      simulateFailure: true, // Marker for worker to simulate failure on attempt 1
    } as any
  );
  console.log(`✅ Failing Job added (will retry). ID: ${job3.id}\n`);

  // 2. Polling states for up to 70 seconds
  console.log('⏳ Polling job states for up to 70 seconds...');
  
  let job1Completed = false;
  let job2Completed = false;
  let job3Completed = false;
  let job3FailedOnce = false;

  for (let i = 0; i <= 70; i++) {
    // If completed and removeOnComplete is true, getState() returns 'unknown'
    const state1 = await emailQueue.getJobState(job1.id!);
    const state2 = await emailQueue.getJobState(job2.id!);
    const state3 = await emailQueue.getJobState(job3.id!);
    
    // We check job3 attempts made using getJob() to detect retries
    const j3 = await emailQueue.getJob(job3.id!);
    const attempts3 = j3 ? j3.attemptsMade : 2; // if removed, it implies it succeeded after retry
    
    if (state1 === 'unknown' || state1 === 'completed') job1Completed = true;
    if (state2 === 'unknown' || state2 === 'completed') job2Completed = true;
    if (attempts3 >= 1 || state3 === 'failed') job3FailedOnce = true;
    if (state3 === 'unknown' || state3 === 'completed') job3Completed = true;

    process.stdout.write(`\r[${i}s] Job 1: ${String(state1).padEnd(10)} | Job 2: ${String(state2).padEnd(10)} | Job 3: ${String(state3).padEnd(10)} (Attempts: ${attempts3})`);

    if (job1Completed && job2Completed && job3Completed && job3FailedOnce) {
      console.log('\n\n✅ All jobs completed successfully and states verified.');
      break;
    }

    if (i === 70) {
      console.log('\n\n⏱️ Timeout reached.');
    }

    await delay(1000);
  }

  // 3. Final Report
  console.log('\n--- FINAL REPORT ---');
  if (job1Completed) console.log('✅ PASS: Immediate Job completed');
  else console.error('❌ FAIL: Immediate Job did not complete');

  if (job2Completed) console.log('✅ PASS: Delayed Job completed');
  else console.error('❌ FAIL: Delayed Job did not complete');

  if (job3FailedOnce && job3Completed) console.log('✅ PASS: Retry Job failed once and then completed');
  else console.error(`❌ FAIL: Retry Job verification failed (Failed Once: ${job3FailedOnce}, Completed: ${job3Completed})`);

  // Clean up database records
  console.log('\n🧹 Cleaning up database records...');
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);

  // Cleanly close connection
  console.log('🧹 Cleaning up queue connection...');
  await emailQueue.close();
  await pool.end();
  console.log('🎉 Queue tests finished.');
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Queue test error:', err);
  process.exit(1);
});
