/**
 * backend/src/scripts/testBoundedWorker.ts
 *
 * Verification Suite for Safe Bounded Cloud Email Worker:
 *  1. Neon PostgreSQL & Upstash Redis TLS connection parsing.
 *  2. Distributed lock concurrency protection (two workers cannot overlap).
 *  3. Controlled test job execution and canonical state transitions.
 *  4. Idempotent delivery protection (already-sent delivery is never duplicated).
 *  5. Graceful shutdown and idle queue drain exit.
 */

process.env.START_WORKER = 'false';

import { Client, Pool } from 'pg';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import assert from 'assert';
import { runMigrations } from '../db/migrate';
import { redis } from '../db/redis';
import { buildRedisConnectionOptions, redisConnectionOptions, EmailJobPayload } from '../queue/emailQueue';
import { runBoundedWorker } from '../workers/boundedWorker';
import { safeEncrypt } from '../utils/crypto';
import { setDefaultTransporter, resetDefaultTransporter } from '../services/emailService';

const SEP = '='.repeat(74);
const SUB_SEP = '-'.repeat(74);

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';

const TEST_DB_NAME = `reachinbox_bounded_test_${process.pid}_${Date.now()}`;
const TEST_QUEUE_NAME = `email-queue-bounded-test-${process.pid}-${Date.now()}`;

let passed = 0;
let failed = 0;

function testAssert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${testName}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

async function main(): Promise<void> {
  console.log('\n' + SEP);
  console.log('  VERIFICATION SUITE: SAFE BOUNDED CLOUD EMAIL WORKER');
  console.log(`  Ephemeral Test DB:    ${TEST_DB_NAME}`);
  console.log(`  Ephemeral Test Queue: ${TEST_QUEUE_NAME}`);
  console.log(SEP + '\n');

  // 1. Prepare ephemeral test database
  const rootClient = new Client({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: 'postgres',
  });
  await rootClient.connect();

  await rootClient.query(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();
  `);
  await rootClient.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
  await rootClient.query(`CREATE DATABASE ${TEST_DB_NAME};`);
  console.log(`1. Ephemeral database "${TEST_DB_NAME}" created.\n`);

  const testPool = new Pool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: TEST_DB_NAME,
    max: 10,
  });

  const testQueue = new Queue<EmailJobPayload>(TEST_QUEUE_NAME, {
    connection: redisConnectionOptions,
  });

  try {
    // 2. Apply migrations
    console.log('2. Applying schema migrations...');
    const testClient = await testPool.connect();
    try {
      await runMigrations(testClient);
      console.log('   Schema migrations applied successfully.\n');
    } finally {
      testClient.release();
    }

    // -------------------------------------------------------------------------
    // TEST 1: Neon & Upstash TLS Connection Parsing
    // -------------------------------------------------------------------------
    console.log(SUB_SEP);
    console.log('TEST 1: Upstash Redis & Neon SSL Connection Options');
    console.log(SUB_SEP);

    const upstashUrl = 'rediss://default:secrettoken123@us1-quick-fox-12345.upstash.io:6379';
    const upstashOpts = buildRedisConnectionOptions(upstashUrl);
    testAssert(upstashOpts.host === 'us1-quick-fox-12345.upstash.io', 'Upstash host correctly parsed');
    testAssert(upstashOpts.port === 6379, 'Upstash port correctly parsed');
    testAssert(upstashOpts.username === 'default', 'Upstash username correctly parsed');
    testAssert(upstashOpts.password === 'secrettoken123', 'Upstash password correctly parsed');
    testAssert(upstashOpts.tls !== undefined, 'Upstash TLS option enabled for rediss://');
    testAssert(upstashOpts.tls.rejectUnauthorized === true, 'Upstash TLS strict rejectUnauthorized enabled');
    testAssert(upstashOpts.tls.servername === 'us1-quick-fox-12345.upstash.io', 'Upstash TLS servername SNI matches hostname');
    testAssert(upstashOpts.maxRetriesPerRequest === null, 'BullMQ maxRetriesPerRequest is strictly null');

    const standardOpts = buildRedisConnectionOptions();
    testAssert(Boolean(standardOpts.host), 'Fallback options provide valid host');
    testAssert(standardOpts.maxRetriesPerRequest === null, 'Standard options have maxRetriesPerRequest = null');

    // -------------------------------------------------------------------------
    // TEST 2: Distributed Concurrency Lock (Mutual Exclusion)
    // -------------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 2: Distributed Concurrency Lock Protection');
    console.log(SUB_SEP);

    const testLockKey = `reachinbox:test:lock:${Date.now()}`;
    const mockExternalInstance = 'external-worker-instance-999';

    // Acquire lock externally to simulate another running worker
    await redis.set(testLockKey, mockExternalInstance, 'PX', 30000, 'NX');

    const contentionResult = await runBoundedWorker(
      {
        lockKey: testLockKey,
        maxDurationMs: 5000,
        idleTimeoutMs: 1000,
        pollIntervalMs: 500,
        queueName: TEST_QUEUE_NAME,
      },
      testPool
    );

    testAssert(contentionResult.status === 'lock_contention', 'Worker detects active lock and reports lock_contention');
    testAssert(contentionResult.processedCount === 0, 'Zero jobs processed during lock contention');

    // Verify external lock was NOT deleted by the worker
    const lockVal = await redis.get(testLockKey);
    testAssert(lockVal === mockExternalInstance, 'External lock was safely preserved and not released by contending worker');

    // Clean up external lock
    await redis.del(testLockKey);

    // -------------------------------------------------------------------------
    // TEST 3: Controlled Test Job Processing & State Transitions
    // -------------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 3: Controlled Test Job Processing in Bounded Window');
    console.log(SUB_SEP);

    // Seed User
    const userRes = await testPool.query(
      `INSERT INTO users (email, name) VALUES ('bounded_user@test.com', 'Bounded User') RETURNING id;`
    );
    const userId = userRes.rows[0].id;

    // Seed Sender
    const encPass = safeEncrypt('test_smtp_pass_bounded');
    const senderRes = await testPool.query(
      `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, hourly_limit)
       VALUES ($1, 'Bounded Sender', 'bounded@sender.com', 'smtp.ethereal.email', 587, false, 'bounded_smtp_user', $2, 100)
       RETURNING id;`,
      [userId, encPass]
    );
    const senderId = senderRes.rows[0].id;

    // Seed Campaign with default sender (NULL) to use controlled defaultTransporter mock
    const campRes = await testPool.query(
      `INSERT INTO campaigns (user_id, sender_id, subject, body, status)
       VALUES ($1, NULL, 'Bounded Worker Test Campaign', 'Test Body', 'scheduled')
       RETURNING id;`,
      [userId]
    );
    const campaignId = campRes.rows[0].id;

    // Seed Recipient
    const recRes = await testPool.query(
      `INSERT INTO recipients (campaign_id, email, name, status)
       VALUES ($1, 'recipient1@example.com', 'Recipient 1', 'pending')
       RETURNING id;`,
      [campaignId]
    );
    const recipientId = recRes.rows[0].id;

    // Seed Delivery Record
    const dedupKey = `campaign_${campaignId}_${recipientId}`;
    const delRes = await testPool.query(
      `INSERT INTO email_deliveries (campaign_id, recipient_id, sender_id, idempotency_key, status, scheduled_at, attempt_count)
       VALUES ($1, $2, NULL, $3, 'scheduled', NOW(), 0)
       RETURNING id;`,
      [campaignId, recipientId, dedupKey]
    );
    const deliveryId = delRes.rows[0].id;

    // Install mock transporter to avoid sending actual email
    const mockMessageId = `<mock-bounded-${Date.now()}@ethereal.email>`;
    setDefaultTransporter({
      sendMail: async () => ({
        messageId: mockMessageId,
        response: `250 OK: queued as ${mockMessageId}`,
        accepted: ['recipient1@example.com'],
        rejected: [],
      }),
    } as any);

    // Enqueue job to isolated test queue
    await testQueue.add(
      'send-email',
      {
        campaignId,
        recipientId,
        deliveryId,
      },
      { jobId: dedupKey }
    );

    // Run bounded worker targeting the test queue
    const runResult = await runBoundedWorker(
      {
        lockKey: `reachinbox:test:lock:${Date.now()}`,
        maxDurationMs: 10000,
        idleTimeoutMs: 1500,
        pollIntervalMs: 500,
        queueName: TEST_QUEUE_NAME,
      },
      testPool
    );

    testAssert(runResult.status === 'completed', 'Bounded worker ran to completion');
    testAssert(runResult.processedCount === 1, 'Bounded worker processed exactly 1 job');
    testAssert(runResult.failedCount === 0, 'Zero jobs failed');

    // Verify delivery status in PostgreSQL
    const delCheck = await testPool.query(
      `SELECT status, attempt_count, smtp_message_id, sent_at FROM email_deliveries WHERE id = $1`,
      [deliveryId]
    );
    const delRow = delCheck.rows[0];
    testAssert(delRow.status === 'sent', 'Delivery record transitioned to "sent"');
    testAssert(delRow.attempt_count === 1, 'Delivery attempt_count is 1');
    testAssert(delRow.smtp_message_id === mockMessageId, 'Delivery records genuine SMTP message ID');
    testAssert(delRow.sent_at !== null, 'Delivery records sent_at timestamp');

    // Verify attempt record
    const attCheck = await testPool.query(
      `SELECT status, smtp_response_code, error_classification FROM email_attempts WHERE delivery_id = $1`,
      [deliveryId]
    );
    testAssert(attCheck.rows.length === 1, 'Attempt record created in email_attempts');
    testAssert(attCheck.rows[0].status === 'sent', 'Attempt status is "sent"');
    testAssert(attCheck.rows[0].smtp_response_code === '250', 'SMTP response code is 250');
    testAssert(attCheck.rows[0].error_classification === 'confirmed_acceptance', 'Attempt classified as confirmed_acceptance');

    // Verify campaign status updated to completed
    const campCheck = await testPool.query(`SELECT status FROM campaigns WHERE id = $1`, [campaignId]);
    testAssert(campCheck.rows[0].status === 'completed', 'Campaign marked "completed" after all deliveries processed');

    // -------------------------------------------------------------------------
    // TEST 4: Idempotent Delivery Protection
    // -------------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 4: Idempotency Protection (No Duplicate Sends)');
    console.log(SUB_SEP);

    // Re-enqueue the same job to test queue
    await testQueue.add(
      'send-email',
      {
        campaignId,
        recipientId,
        deliveryId,
      },
      { jobId: `re-enqueue-${Date.now()}` }
    );

    const rerunResult = await runBoundedWorker(
      {
        lockKey: `reachinbox:test:lock:${Date.now()}`,
        maxDurationMs: 8000,
        idleTimeoutMs: 1500,
        pollIntervalMs: 500,
        queueName: TEST_QUEUE_NAME,
      },
      testPool
    );

    // Verify delivery was NOT re-sent
    const checkNoResend = await testPool.query(
      `SELECT status, attempt_count FROM email_deliveries WHERE id = $1`,
      [deliveryId]
    );
    testAssert(checkNoResend.rows[0].status === 'sent', 'Delivery remains "sent"');
    testAssert(checkNoResend.rows[0].attempt_count === 1, 'Attempt count strictly unchanged (not incremented)');

    // Verify attempt records count is still 1
    const checkAttemptsCount = await testPool.query(
      `SELECT count(*) FROM email_attempts WHERE delivery_id = $1`,
      [deliveryId]
    );
    testAssert(parseInt(checkAttemptsCount.rows[0].count, 10) === 1, 'No duplicate attempt records inserted');

    // -------------------------------------------------------------------------
    // TEST 5: Idle Queue Drain Graceful Exit
    // -------------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 5: Empty Queue Graceful Drain & Quick Exit');
    console.log(SUB_SEP);

    const emptyQueueStartTime = Date.now();
    const emptyQueueResult = await runBoundedWorker(
      {
        lockKey: `reachinbox:test:lock:${Date.now()}`,
        maxDurationMs: 30000,
        idleTimeoutMs: 1000,
        pollIntervalMs: 200,
        queueName: TEST_QUEUE_NAME,
      },
      testPool
    );

    const emptyQueueDuration = Date.now() - emptyQueueStartTime;
    testAssert(emptyQueueResult.status === 'completed', 'Empty queue run completes cleanly');
    testAssert(emptyQueueResult.processedCount === 0, 'Zero jobs processed on empty queue');
    testAssert(emptyQueueDuration < 5000, `Worker exited early after idle timeout (${emptyQueueDuration}ms < 5000ms)`);

    console.log('\n' + SEP);
    console.log(`  BOUNDED WORKER VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
    console.log(SEP + '\n');

  } finally {
    resetDefaultTransporter();
    console.log('Cleaning up ephemeral test resources...');
    try {
      await testQueue.obliterate({ force: true });
      await testQueue.close();
    } catch (_) {}

    await testPool.end();
    await rootClient.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();
    `);
    await rootClient.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await rootClient.end();
    console.log('Cleanup complete.\n');
  }

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
