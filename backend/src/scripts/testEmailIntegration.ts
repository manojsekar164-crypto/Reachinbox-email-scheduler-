import { db as pool } from '../db/postgres';
import { emailQueue } from '../queue/emailQueue';

/**
 * src/scripts/testEmailIntegration.ts
 *
 * Full integration test for Phase 6.
 * Demonstrates:
 * 1. Successful email send.
 * 2. Failure logging and BullMQ retry.
 * 3. Idempotency (duplicate jobs are ignored).
 */

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log('🧪 Starting Email Integration Tests...\n');

  try {
    // 1. Setup Test Data in PostgreSQL
    console.log('🔄 Setting up test data...');
    
    // Create a mock user
    const userRes = await pool.query(
      `INSERT INTO users (email, name) VALUES ('test-integration@example.com', 'Integration Test User') 
       ON CONFLICT (email) DO UPDATE SET name = 'Integration Test User' RETURNING id`
    );
    const userId = userRes.rows[0].id;

    // Create a mock campaign
    const campaignRes = await pool.query(
      `INSERT INTO campaigns (user_id, subject, body, hourly_limit, status) 
       VALUES ($1, 'Integration Test Subject: Hello {{name}}', 'This is an integration test body for {{name}}.', 10, 'sending') 
       RETURNING id`,
      [userId]
    );
    const campaignId = campaignRes.rows[0].id;

    // Create a mock recipient
    const recipientRes = await pool.query(
      `INSERT INTO recipients (campaign_id, email, name, status) 
       VALUES ($1, 'recipient@example.com', 'John Doe', 'pending') 
       RETURNING id`,
      [campaignId]
    );
    const recipientId = recipientRes.rows[0].id;

    console.log(`✅ Test data created. Campaign ID: ${campaignId}, Recipient ID: ${recipientId}\n`);

    // 2. SUCCESS TEST
    console.log('--- 1. SUCCESS TEST ---');
    const jobSuccess = await emailQueue.add('send-email', {
      campaignId,
      recipientId,
    });
    console.log(`✅ Success Job added. ID: ${jobSuccess.id}`);
    
    // Wait for the job to complete
    let successState = await jobSuccess.getState();
    while (successState !== 'completed' && successState !== 'failed' && successState !== 'unknown') {
      await delay(1000);
      successState = await emailQueue.getJobState(jobSuccess.id!) || 'unknown';
    }
    
    const logsSuccess = await pool.query(
      "SELECT * FROM email_logs WHERE campaign_id = $1 AND recipient_id = $2 AND status = 'sent' ORDER BY created_at DESC",
      [campaignId, recipientId]
    );
    if (logsSuccess.rows.length > 0) {
      console.log('✅ SUCCESS TEST PASSED: email_logs contains status="sent"\n');
    } else {
      console.error('❌ SUCCESS TEST FAILED: email_logs does not contain status="sent"\n');
    }

    // 3. IDEMPOTENCY TEST (Duplicate Job)
    console.log('--- 2. IDEMPOTENCY TEST ---');
    console.log('Adding the exact same job again...');
    const jobDuplicate = await emailQueue.add('send-email', {
      campaignId,
      recipientId,
    });
    console.log(`✅ Duplicate Job added. ID: ${jobDuplicate.id}`);
    
    let dupState = await jobDuplicate.getState();
    while (dupState !== 'completed' && dupState !== 'failed' && dupState !== 'unknown') {
      await delay(1000);
      dupState = await emailQueue.getJobState(jobDuplicate.id!) || 'unknown';
    }

    const logsDuplicate = await pool.query(
      "SELECT * FROM email_logs WHERE campaign_id = $1 AND recipient_id = $2 ORDER BY created_at DESC",
      [campaignId, recipientId]
    );
    
    const sentCount = logsDuplicate.rows.filter((r: any) => r.status === 'sent').length;
    if (sentCount === 1) {
      console.log('✅ IDEMPOTENCY TEST PASSED: Only 1 successful email_logs record exists.\n');
    } else {
      console.error(`❌ IDEMPOTENCY TEST FAILED: Found ${sentCount} successful records.\n`);
    }

    // 4. FAILURE AND RETRY TEST
    console.log('--- 3. FAILURE & RETRY TEST ---');
    const recipientFailRes = await pool.query(
      `INSERT INTO recipients (campaign_id, email, name, status) 
       VALUES ($1, 'fail-recipient@example.com', 'Jane Doe', 'pending') 
       RETURNING id`,
      [campaignId]
    );
    const recipientFailId = recipientFailRes.rows[0].id;

    const jobRetry = await emailQueue.add('send-email', {
      campaignId,
      recipientId: recipientFailId,
      simulateFailure: true,
    } as any);
    console.log(`✅ Retry Job added. ID: ${jobRetry.id}`);
    
    let retryState = await jobRetry.getState();
    // Wait until it completes (it will fail once, transition to delayed, then retry and complete)
    while (retryState !== 'completed' && retryState !== 'unknown') {
      await delay(1000);
      retryState = await emailQueue.getJobState(jobRetry.id!) || 'unknown';
    }

    const logsRetry = await pool.query(
      "SELECT status, error_message FROM email_logs WHERE campaign_id = $1 AND recipient_id = $2 ORDER BY created_at ASC",
      [campaignId, recipientFailId]
    );

    if (logsRetry.rows.length >= 2 && logsRetry.rows[0].status === 'failed' && logsRetry.rows[logsRetry.rows.length - 1].status === 'sent') {
      console.log('✅ RETRY TEST PASSED: email_logs recorded failure then success.');
      console.log(`   Failure reason logged: ${logsRetry.rows[0].error_message}\n`);
    } else {
      console.error('❌ RETRY TEST FAILED: email_logs did not capture failure -> success sequence.\n');
      console.log(logsRetry.rows);
    }

    console.log('🎉 All integration tests finished.');

  } catch (err) {
    console.error('❌ Integration test failed:', err);
  } finally {
    console.log('🧹 Cleaning up connections...');
    await emailQueue.close();
    await pool.end();
    process.exit(0);
  }
}

main();
