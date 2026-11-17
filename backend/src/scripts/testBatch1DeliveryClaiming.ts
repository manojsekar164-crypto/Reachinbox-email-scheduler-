/**
 * src/scripts/testBatch1DeliveryClaiming.ts
 *
 * Verification Suite for Batch 1 – Atomic Delivery Claiming and Worker Idempotency.
 *
 * SAFETY INVARIANT:
 *  - Runs strictly against an isolated ephemeral database: `reachinbox_migration_test`.
 *  - Restores verified production backup: `reachinbox-pre-stage1.dump`.
 *  - Executes migrations 001–007 in the isolated database.
 *  - Tests all 4 mandatory acceptance criteria:
 *      1. Two workers claiming the same delivery concurrently.
 *      2. Processing an already-sent delivery.
 *      3. Reprocessing a duplicate BullMQ job.
 *      4. An uncertain delivery outcome.
 *      5. Soft-delete and campaign status eligibility safety.
 *  - Cleans up and verifies production DB `reachinbox` remains 100% untouched.
 */

// Disable automatic background worker startup when importing emailWorker in test environment
process.env.START_WORKER = 'false';
process.env.SEND_DELAY_TEST_MS = '0';
process.env.DISABLE_ES_INDEXING = 'true';

import { Client, Pool } from 'pg';
import { execSync } from 'child_process';
import { runMigrations } from '../db/migrate';
import {
  claimDelivery,
  getDelivery,
  ensureDeliveryRecord,
  isUncertainSmtpError,
} from '../services/deliveryService';
import { processEmailJob } from '../workers/emailWorker';
import { safeEncrypt } from '../utils/crypto';

const SEP = '='.repeat(74);
const SUB_SEP = '-'.repeat(74);

const TEST_DB_NAME = 'reachinbox_migration_test';
const BASE_PG_CONFIG = {
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${testName}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

async function runBatch1Verification(): Promise<void> {
  console.log('\n' + SEP);
  console.log('  BATCH 1 VERIFICATION: ATOMIC CLAIMING & WORKER IDEMPOTENCY');
  console.log('  Target Database: ' + TEST_DB_NAME + ' (Ephemeral Isolated Test DB)');
  console.log('  Production DB:   reachinbox (UNTOUCHED)');
  console.log(SEP + '\n');

  // Step 1: Connect to postgres server to manage ephemeral test DB
  const adminClient = new Client({
    ...BASE_PG_CONFIG,
    database: 'postgres',
  });
  await adminClient.connect();

  try {
    console.log('1. Preparing isolated ephemeral test database...');
    await adminClient.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();
    `);
    await adminClient.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminClient.query(`CREATE DATABASE ${TEST_DB_NAME};`);
    console.log(`   Database "${TEST_DB_NAME}" created.\n`);

    // Step 2: Restore verified backup
    console.log('2. Restoring pre-stage1 backup into isolated database...');
    const backupContainerPath = '/tmp/reachinbox-pre-stage1.dump';
    execSync(
      `docker exec reachinbox_postgres pg_restore -U postgres -d ${TEST_DB_NAME} --no-owner --no-privileges ${backupContainerPath}`,
      { stdio: 'pipe' }
    );
    console.log('   pg_restore completed successfully.\n');

    // Step 3: Run migrations 001–007 against isolated database
    console.log('3. Applying schema migrations to isolated database...');
    const testClient = new Client({
      ...BASE_PG_CONFIG,
      database: TEST_DB_NAME,
    });
    await testClient.connect();

    // Dedicated pool and clients for concurrency tests
    const testPool = new Pool({
      ...BASE_PG_CONFIG,
      database: TEST_DB_NAME,
      max: 10,
    });

    try {
      const migrationResult = await runMigrations(testClient);
      console.log(`   Migrations applied: ${migrationResult.applied.length}, skipped: ${migrationResult.skipped.length}\n`);

      // Step 4: Seed test data for Batch 1 tests
      console.log('4. Seeding test fixtures in isolated database...');
      const senderRes = await testClient.query('SELECT id, user_id FROM senders LIMIT 1');
      const senderId = senderRes.rows[0].id;
      const userId = senderRes.rows[0].user_id;

      // Configure test sender with verified live test credentials
      await testClient.query(`
        UPDATE senders
        SET smtp_host = 'smtp.ethereal.email',
            smtp_port = 587,
            smtp_user = 'wloczhozkkortejc@ethereal.email',
            smtp_pass = $1,
            smtp_secure = false,
            hourly_limit = 1000
        WHERE id = $2;
      `, [safeEncrypt('hRM8Run8JE4GVkxkxj'), senderId]);

      // Create an active campaign in 'sending' status
      const campRes = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
        VALUES ($1, $2, 'Batch 1 Test Subject', 'Hello {{name}}', 'sending', 1000)
        RETURNING id;
      `, [userId, senderId]);
      const campaignId = campRes.rows[0].id;

      console.log(`   Created test campaign: ${campaignId} (status: sending)\n`);

      // ======================================================================
      // TEST 1: Two Workers Claiming the Same Delivery Concurrently
      // ======================================================================
      console.log(SUB_SEP);
      console.log('TEST 1: Two workers claiming the same delivery concurrently');
      console.log(SUB_SEP);

      const r1 = await testClient.query(`
        INSERT INTO recipients (campaign_id, email, name, status)
        VALUES ($1, 'worker_race_test@reachinbox.test', 'Worker Race', 'pending')
        RETURNING id;
      `, [campaignId]);
      const recip1Id = r1.rows[0].id;

      // Ensure delivery record exists in 'pending' status
      await ensureDeliveryRecord({ campaignId, recipientId: recip1Id, senderId }, testClient);

      // Connect two distinct clients to simulate two separate worker processes
      const clientWorker1 = await testPool.connect();
      const clientWorker2 = await testPool.connect();

      try {
        // Concurrently attempt to claim the exact same delivery
        const [claimResult1, claimResult2] = await Promise.all([
          claimDelivery({
            campaignId,
            recipientId: recip1Id,
            claimOwner: 'worker_instance_alpha',
            leaseDurationMs: 30000,
            dbClient: clientWorker1,
          }),
          claimDelivery({
            campaignId,
            recipientId: recip1Id,
            claimOwner: 'worker_instance_beta',
            leaseDurationMs: 30000,
            dbClient: clientWorker2,
          }),
        ]);

        const successfulClaims = [claimResult1, claimResult2].filter((c) => c !== null);
        const skippedClaims = [claimResult1, claimResult2].filter((c) => c === null);

        assert(
          successfulClaims.length === 1,
          'Exactly one worker successfully claimed the delivery',
          `successful=${successfulClaims.length}`
        );
        assert(
          skippedClaims.length === 1,
          'The second concurrent worker received NULL (skipped without blocking)',
          `skipped=${skippedClaims.length}`
        );

        const winner = successfulClaims[0]!;
        assert(
          winner.status === 'sending',
          'Delivery status atomically transitioned to "sending"',
          `status=${winner.status}`
        );
        assert(
          winner.attempt_count === 1,
          'Delivery attempt_count atomically incremented to 1',
          `attempt_count=${winner.attempt_count}`
        );
        assert(
          winner.claim_owner !== null && winner.lease_expires_at !== null,
          'Claim owner and lease expiry timestamp recorded'
        );

        // Verify state in database
        const dbCheck = await testClient.query(
          'SELECT status, claim_owner, attempt_count FROM email_deliveries WHERE campaign_id = $1 AND recipient_id = $2',
          [campaignId, recip1Id]
        );
        assert(
          dbCheck.rows[0].status === 'sending' && dbCheck.rows[0].claim_owner === winner.claim_owner,
          'Database state matches winning worker claim'
        );
      } finally {
        clientWorker1.release();
        clientWorker2.release();
      }

      // ======================================================================
      // TEST 2: Processing an Already-Sent Delivery
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('TEST 2: Processing an already-sent delivery');
      console.log(SUB_SEP);

      const r2 = await testClient.query(`
        INSERT INTO recipients (campaign_id, email, name, status)
        VALUES ($1, 'already_sent@reachinbox.test', 'Already Sent User', 'sent')
        RETURNING id;
      `, [campaignId]);
      const recip2Id = r2.rows[0].id;

      // Seed as already sent in email_deliveries
      const idempKey2 = `campaign_${campaignId}_${recip2Id}`;
      await testClient.query(`
        INSERT INTO email_deliveries (campaign_id, recipient_id, idempotency_key, status, sent_at, attempt_count)
        VALUES ($1, $2, $3, 'sent', NOW(), 1);
      `, [campaignId, recip2Id, idempKey2]);

      // Count attempts before worker execution
      const preAttempts2 = await testClient.query(
        'SELECT COUNT(*) as cnt FROM email_attempts WHERE delivery_id IN (SELECT id FROM email_deliveries WHERE campaign_id = $1 AND recipient_id = $2)',
        [campaignId, recip2Id]
      );
      const preCount2 = parseInt(preAttempts2.rows[0].cnt, 10);

      // Invoke worker processing
      await processEmailJob(
        {
          id: 'test_job_already_sent',
          data: { campaignId, recipientId: recip2Id },
          attemptsMade: 0,
        },
        testPool
      );

      // Verify no new attempt was logged and delivery remains sent
      const postDelivery2 = await getDelivery(campaignId, recip2Id, testClient);
      const postAttempts2 = await testClient.query(
        'SELECT COUNT(*) as cnt FROM email_attempts WHERE delivery_id = $1',
        [postDelivery2!.id]
      );
      const postCount2 = parseInt(postAttempts2.rows[0].cnt, 10);

      assert(postDelivery2!.status === 'sent', 'Delivery status remains "sent"');
      assert(postCount2 === preCount2, 'Zero new email_attempts recorded for already-sent delivery');
      assert(postDelivery2!.attempt_count === 1, 'Delivery attempt count was not incremented');

      // ======================================================================
      // TEST 3: Reprocessing a Duplicate BullMQ Job
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('TEST 3: Reprocessing a duplicate BullMQ job');
      console.log(SUB_SEP);

      const r3 = await testClient.query(`
        INSERT INTO recipients (campaign_id, email, name, status)
        VALUES ($1, 'duplicate_job@reachinbox.test', 'Duplicate Job User', 'pending')
        RETURNING id;
      `, [campaignId]);
      const recip3Id = r3.rows[0].id;

      await ensureDeliveryRecord({ campaignId, recipientId: recip3Id, senderId }, testClient);

      // Job execution 1 (initial send)
      console.log('   Executing Job Run 1 (initial delivery)...');
      await processEmailJob(
        {
          id: 'bullmq_job_original',
          data: { campaignId, recipientId: recip3Id },
          attemptsMade: 0,
        },
        testPool
      );

      const deliveryRun1 = await getDelivery(campaignId, recip3Id, testClient);
      assert(deliveryRun1!.status === 'sent', 'Run 1 marked delivery as "sent"');
      assert(deliveryRun1!.attempt_count === 1, 'Run 1 attempt_count is 1');

      const attemptsRun1 = await testClient.query(
        'SELECT COUNT(*) as cnt FROM email_attempts WHERE delivery_id = $1',
        [deliveryRun1!.id]
      );
      assert(parseInt(attemptsRun1.rows[0].cnt, 10) === 1, 'Exactly 1 attempt recorded after Run 1');

      // Job execution 2 (duplicate delivery arriving via BullMQ)
      console.log('   Executing Job Run 2 (duplicate BullMQ job arrival)...');
      await processEmailJob(
        {
          id: 'bullmq_job_duplicate',
          data: { campaignId, recipientId: recip3Id },
          attemptsMade: 0,
        },
        testPool
      );

      const deliveryRun2 = await getDelivery(campaignId, recip3Id, testClient);
      assert(deliveryRun2!.status === 'sent', 'Run 2 preserves "sent" delivery status');
      assert(deliveryRun2!.attempt_count === 1, 'Duplicate job did not increment attempt_count (idempotent)');

      const attemptsRun2 = await testClient.query(
        'SELECT COUNT(*) as cnt FROM email_attempts WHERE delivery_id = $1',
        [deliveryRun2!.id]
      );
      assert(
        parseInt(attemptsRun2.rows[0].cnt, 10) === 1,
        'Duplicate job made ZERO new attempts in email_attempts'
      );

      // ======================================================================
      // TEST 4: An Uncertain Delivery Outcome
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('TEST 4: An uncertain delivery outcome');
      console.log(SUB_SEP);

      const r4 = await testClient.query(`
        INSERT INTO recipients (campaign_id, email, name, status)
        VALUES ($1, 'uncertain_test@reachinbox.test', 'Uncertain User', 'pending')
        RETURNING id;
      `, [campaignId]);
      const recip4Id = r4.rows[0].id;

      await ensureDeliveryRecord({ campaignId, recipientId: recip4Id, senderId }, testClient);

      // First run with simulateUncertain: simulates socket reset / timeout waiting for 250 OK
      console.log('   Executing send with simulated uncertain SMTP timeout...');
      let threwError = false;
      try {
        await processEmailJob(
          {
            id: 'job_uncertain_test',
            data: { campaignId, recipientId: recip4Id, simulateUncertain: true },
            attemptsMade: 0,
          },
          testPool
        );
      } catch {
        threwError = true;
      }

      assert(
        !threwError,
        'Worker caught uncertain outcome and did NOT rethrow (prevented BullMQ auto-retry)'
      );

      const deliveryUncertain = await getDelivery(campaignId, recip4Id, testClient);
      assert(
        deliveryUncertain!.status === 'unknown',
        'Canonical delivery status transitioned to "unknown"',
        `status=${deliveryUncertain?.status}`
      );
      assert(
        deliveryUncertain!.last_error !== null && deliveryUncertain!.last_error.includes('Uncertain SMTP delivery outcome'),
        'Delivery last_error preserves forensic uncertain context'
      );

      const attemptUncertain = await testClient.query(
        'SELECT status, error_message FROM email_attempts WHERE delivery_id = $1 ORDER BY attempt_number DESC LIMIT 1',
        [deliveryUncertain!.id]
      );
      assert(
        attemptUncertain.rows[0].status === 'unknown',
        'Attempt status recorded as "unknown" in email_attempts'
      );

      // Now verify that a subsequent retry attempt REFUSES to blindly send
      console.log('   Attempting subsequent automatic retry on uncertain delivery...');
      await processEmailJob(
        {
          id: 'job_uncertain_retry_attempt',
          data: { campaignId, recipientId: recip4Id },
          attemptsMade: 1,
        },
        testPool
      );

      const deliveryAfterRetry = await getDelivery(campaignId, recip4Id, testClient);
      assert(
        deliveryAfterRetry!.status === 'unknown',
        'Subsequent retry safely skipped: status remains "unknown"'
      );

      const totalAttempts4 = await testClient.query(
        'SELECT COUNT(*) as cnt FROM email_attempts WHERE delivery_id = $1',
        [deliveryUncertain!.id]
      );
      assert(
        parseInt(totalAttempts4.rows[0].cnt, 10) === 1,
        'Never blindly resent: total email_attempts remains 1'
      );

      // ======================================================================
      // TEST 5: Soft-Delete and Campaign Status Eligibility
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('TEST 5: Soft-delete and campaign status eligibility safety');
      console.log(SUB_SEP);

      // Soft-deleted delivery cannot be claimed
      const r5 = await testClient.query(`
        INSERT INTO recipients (campaign_id, email, name, status)
        VALUES ($1, 'soft_deleted@reachinbox.test', 'Soft Deleted', 'pending')
        RETURNING id;
      `, [campaignId]);
      const recip5Id = r5.rows[0].id;

      const idempKey5 = `campaign_${campaignId}_${recip5Id}`;
      await testClient.query(`
        INSERT INTO email_deliveries (campaign_id, recipient_id, idempotency_key, status, deleted_at)
        VALUES ($1, $2, $3, 'pending', NOW());
      `, [campaignId, recip5Id, idempKey5]);

      const softDelClaim = await claimDelivery({
        campaignId,
        recipientId: recip5Id,
        claimOwner: 'worker_test_soft_del',
        dbClient: testClient,
      });
      assert(softDelClaim === null, 'Soft-deleted delivery (deleted_at IS NOT NULL) cannot be claimed');

      // Delivery in a draft campaign cannot be claimed
      const draftCampRes = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, $2, 'Draft Campaign', 'Body', 'draft')
        RETURNING id;
      `, [userId, senderId]);
      const draftCampId = draftCampRes.rows[0].id;

      const r6 = await testClient.query(`
        INSERT INTO recipients (campaign_id, email, name, status)
        VALUES ($1, 'draft_recipient@reachinbox.test', 'Draft Recip', 'pending')
        RETURNING id;
      `, [draftCampId]);
      const recip6Id = r6.rows[0].id;

      await ensureDeliveryRecord({ campaignId: draftCampId, recipientId: recip6Id, senderId }, testClient);

      const draftClaim = await claimDelivery({
        campaignId: draftCampId,
        recipientId: recip6Id,
        claimOwner: 'worker_test_draft',
        dbClient: testClient,
      });
      assert(draftClaim === null, 'Draft campaign delivery cannot be claimed (campaign status != sending)');

    } finally {
      await testPool.end();
      await testClient.end();
    }

    // Step 5: Clean up isolated test DB
    console.log('\n5. Cleaning up isolated test database...');
    await adminClient.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();
    `);
    await adminClient.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    console.log(`   Database "${TEST_DB_NAME}" dropped cleanly.`);

    // Step 6: Verify original reachinbox database was NEVER touched
    console.log('\n6. Verifying original database integrity...');
    const prodCheck = new Client({
      ...BASE_PG_CONFIG,
      database: 'reachinbox',
    });
    await prodCheck.connect();
    try {
      const origTables = await prodCheck.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name;
      `);
      const tableNames = origTables.rows.map((r) => r.table_name);
      assert(
        !tableNames.includes('email_deliveries') && !tableNames.includes('schema_migrations'),
        'Original "reachinbox" database remains 100% UNTOUCHED (zero migrations executed against it)'
      );
    } finally {
      await prodCheck.end();
    }

  } finally {
    await adminClient.end();
  }

  console.log('\n' + SEP);
  console.log(`  BATCH 1 VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log(SEP + '\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) {
  runBatch1Verification().catch((err) => {
    console.error('Fatal error during Batch 1 verification:', err);
    process.exit(1);
  });
}

export { runBatch1Verification };
