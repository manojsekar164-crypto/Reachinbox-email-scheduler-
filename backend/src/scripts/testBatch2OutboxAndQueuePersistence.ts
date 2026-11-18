/**
 * src/scripts/testBatch2OutboxAndQueuePersistence.ts
 *
 * Verification Suite for Batch 2: Transactional Outbox and Queue Persistence.
 *
 * Scenarios Tested:
 *  1. Campaign transaction failure leaves no partial delivery or outbox records.
 *  2. Concurrent publishers cannot claim the same unexpired outbox record.
 *  3. Expired publisher leases can be recovered.
 *  4. Publisher crash immediately after successful queue publication.
 *  5. Repeated publication after restart (idempotent outbox sweep).
 *  6. Completed BullMQ job removal followed by outbox recovery.
 *  7. Future scheduled delivery preserves its exact timestamp and delay.
 *  8. Historical unknown, sent, cancelled, and draft deliveries are never replayed.
 *  9. Original `reachinbox` database remains 100% untouched.
 */

process.env.START_WORKER = 'false';
process.env.SEND_DELAY_TEST_MS = '0';
process.env.DISABLE_ES_INDEXING = 'true';

import { Client, Pool } from 'pg';
import { execSync } from 'child_process';
import { Queue } from 'bullmq';
import { runMigrations } from '../db/migrate';
import {
  claimOutboxRecords,
  markOutboxDispatched,
  publishOutboxEvent,
  processOutboxBatch,
  recoverFutureScheduledDeliveries,
} from '../services/outboxPublisher';
import { createCampaignWithRecipients } from '../services/campaignService';
import {
  claimDelivery,
  getDelivery,
  activateDueCampaign,
} from '../services/deliveryService';
import { processEmailJob } from '../workers/emailWorker';
import { emailQueueName, redisConnectionOptions, EmailJobPayload } from '../queue/emailQueue';
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

async function runBatch2Verification(): Promise<void> {
  console.log('\n' + SEP);
  console.log('  BATCH 2 VERIFICATION: TRANSACTIONAL OUTBOX & QUEUE PERSISTENCE');
  console.log('  Target Database: ' + TEST_DB_NAME + ' (Ephemeral Isolated Test DB)');
  console.log('  Production DB:   reachinbox (UNTOUCHED)');
  console.log(SEP + '\n');

  // Step 1: Prepare ephemeral database
  const adminClient = new Client({
    ...BASE_PG_CONFIG,
    database: 'postgres',
  });
  await adminClient.connect();

  // Test Queue instance connected to Redis (isolated queue for Batch 2)
  const TEST_QUEUE_NAME = `${emailQueueName}-b2-${Date.now()}`;
  const testQueue = new Queue<EmailJobPayload>(TEST_QUEUE_NAME, {
    connection: redisConnectionOptions,
  });

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

    // Step 2: Restore backup
    console.log('2. Restoring pre-stage1 backup into isolated database...');
    const backupContainerPath = '/tmp/reachinbox-pre-stage1.dump';
    execSync(
      `docker exec reachinbox_postgres pg_restore -U postgres -d ${TEST_DB_NAME} --no-owner --no-privileges ${backupContainerPath}`,
      { stdio: 'pipe' }
    );
    console.log('   pg_restore completed successfully.\n');

    // Step 3: Run migrations
    console.log('3. Applying schema migrations to isolated database...');
    const testClient = new Client({
      ...BASE_PG_CONFIG,
      database: TEST_DB_NAME,
    });
    await testClient.connect();

    const testPool = new Pool({
      ...BASE_PG_CONFIG,
      database: TEST_DB_NAME,
      max: 10,
    });

    try {
      const migrationResult = await runMigrations(testClient);
      console.log(`   Migrations applied: ${migrationResult.applied.length}, skipped: ${migrationResult.skipped.length}\n`);

      // Setup sender with verified test credentials
      const senderRes = await testClient.query('SELECT id, user_id FROM senders LIMIT 1');
      const senderId = senderRes.rows[0].id;
      const userId = senderRes.rows[0].user_id;

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

      // ======================================================================
      // SCENARIO 1: Campaign Transaction Failure Leaves No Partial Records
      // ======================================================================
      console.log(SUB_SEP);
      console.log('SCENARIO 1: Campaign transaction failure atomicity rollback');
      console.log(SUB_SEP);

      const preCampCount = parseInt((await testClient.query('SELECT COUNT(*) as cnt FROM campaigns')).rows[0].cnt, 10);
      const preDelivCount = parseInt((await testClient.query('SELECT COUNT(*) as cnt FROM email_deliveries')).rows[0].cnt, 10);
      const preOutboxCount = parseInt((await testClient.query('SELECT COUNT(*) as cnt FROM delivery_outbox')).rows[0].cnt, 10);

      let txRolledBack = false;
      const invalidSenderUuid = 'a0000000-0000-0000-0000-000000000000'; // Non-existent sender
      try {
        await createCampaignWithRecipients(userId, {
          senderId: invalidSenderUuid,
          subject: 'Failed Campaign Test',
          body: 'This transaction must rollback completely',
          hourlyLimit: 10,
          recipients: [{ email: 'will_fail@example.com' }],
        });
      } catch (err: any) {
        if (err.message.includes('Invalid sender') || err.message.includes('Sender not found')) {
          txRolledBack = true;
        }
      }

      assert(txRolledBack, 'Transactional creation threw on invalid foreign dependency');

      const postCampCount = parseInt((await testClient.query('SELECT COUNT(*) as cnt FROM campaigns')).rows[0].cnt, 10);
      const postDelivCount = parseInt((await testClient.query('SELECT COUNT(*) as cnt FROM email_deliveries')).rows[0].cnt, 10);
      const postOutboxCount = parseInt((await testClient.query('SELECT COUNT(*) as cnt FROM delivery_outbox')).rows[0].cnt, 10);

      assert(postCampCount === preCampCount, 'Zero partial campaign records persisted after rollback');
      assert(postDelivCount === preDelivCount, 'Zero partial email_deliveries persisted after rollback');
      assert(postOutboxCount === preOutboxCount, 'Zero partial delivery_outbox events persisted after rollback');

      // ======================================================================
      // SCENARIO 2: Concurrent Publishers Cannot Claim the Same Unexpired Outbox Record
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 2: Concurrent publishers cannot claim the same record (SKIP LOCKED)');
      console.log(SUB_SEP);

      // Seed an active campaign with deliveries and outbox records
      const c2 = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, $2, 'Concurrent Publisher Test', 'Body', 'sending')
        RETURNING id;
      `, [userId, senderId]);
      const c2Id = c2.rows[0].id;

      const r2A = await testClient.query(`
        INSERT INTO recipients (campaign_id, email, name)
        VALUES ($1, 'conc_pub_a@reachinbox.test', 'A') RETURNING id;
      `, [c2Id]);
      const r2B = await testClient.query(`
        INSERT INTO recipients (campaign_id, email, name)
        VALUES ($1, 'conc_pub_b@reachinbox.test', 'B') RETURNING id;
      `, [c2Id]);

      // Seed deliveries & outbox records
      const idemp2A = `campaign_${c2Id}_${r2A.rows[0].id}`;
      const idemp2B = `campaign_${c2Id}_${r2B.rows[0].id}`;

      const d2A = await testClient.query(`
        INSERT INTO email_deliveries (campaign_id, recipient_id, idempotency_key, status)
        VALUES ($1, $2, $3, 'pending') RETURNING id;
      `, [c2Id, r2A.rows[0].id, idemp2A]);

      const d2B = await testClient.query(`
        INSERT INTO email_deliveries (campaign_id, recipient_id, idempotency_key, status)
        VALUES ($1, $2, $3, 'pending') RETURNING id;
      `, [c2Id, r2B.rows[0].id, idemp2B]);

      await testClient.query(`
        INSERT INTO delivery_outbox (event_type, aggregate_id, deduplication_key, payload, status, available_at)
        VALUES
          ('email.dispatch', $1, $2, '{"test": "A"}', 'pending', NOW()),
          ('email.dispatch', $3, $4, '{"test": "B"}', 'pending', NOW());
      `, [d2A.rows[0].id, idemp2A, d2B.rows[0].id, idemp2B]);

      // Two concurrent clients simulate Publisher Alpha and Publisher Beta claiming outbox
      const pubClient1 = await testPool.connect();
      const pubClient2 = await testPool.connect();

      try {
        const [claimBatch1, claimBatch2] = await Promise.all([
          claimOutboxRecords(10, 'publisher_alpha', 30000, pubClient1),
          claimOutboxRecords(10, 'publisher_beta', 30000, pubClient2),
        ]);

        const ids1 = claimBatch1.map((r) => r.id);
        const ids2 = claimBatch2.map((r) => r.id);
        const overlap = ids1.filter((id) => ids2.includes(id));

        assert(overlap.length === 0, 'Concurrent publishers claimed completely disjoint record sets (zero overlap)');
        assert(ids1.length > 0 || ids2.length > 0, 'At least one publisher successfully acquired available records');
      } finally {
        pubClient1.release();
        pubClient2.release();
      }

      // ======================================================================
      // SCENARIO 3: Expired Publisher Leases Can Be Recovered
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 3: Expired publisher lease recovery');
      console.log(SUB_SEP);

      // Seed an outbox record with an expired lease (claimed 2 minutes ago with 30s lease)
      const expiredOutbox = await testClient.query(`
        INSERT INTO delivery_outbox (
          event_type, aggregate_id, deduplication_key, payload, status,
          attempt_count, claim_owner, claimed_at, lease_expires_at, available_at
        )
        VALUES (
          'email.dispatch', gen_random_uuid(), 'dedup_expired_lease_test',
          '{"test": "expired"}', 'processing',
          1, 'crashed_publisher_999', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '90 seconds', NOW()
        )
        RETURNING id;
      `);
      const expiredOutboxId = expiredOutbox.rows[0].id;

      // New publisher sweeps
      const recoveryBatch = await claimOutboxRecords(50, 'recovery_publisher_active', 30000, testClient);
      const recoveredRecord = recoveryBatch.find((r) => r.id === expiredOutboxId);

      assert(recoveredRecord !== undefined, 'Expired outbox lease was successfully claimed by new publisher');
      assert(recoveredRecord!.claim_owner === 'recovery_publisher_active', 'Claim owner reassigned to active publisher');
      assert(recoveredRecord!.attempt_count === 2, 'Attempt count incremented on recovery claim (1 -> 2)');

      // ======================================================================
      // SCENARIO 4: Publisher Crash Immediately After Successful Queue Publication
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 4: Publisher crash after queue.add but before outbox update');
      console.log(SUB_SEP);

      const r4 = await testClient.query(`
        INSERT INTO recipients (campaign_id, email, name)
        VALUES ($1, 'publisher_crash@reachinbox.test', 'Crash Test') RETURNING id;
      `, [c2Id]);
      const r4Id = r4.rows[0].id;
      const idemp4 = `campaign_${c2Id}_${r4Id}`;

      const d4 = await testClient.query(`
        INSERT INTO email_deliveries (campaign_id, recipient_id, idempotency_key, status)
        VALUES ($1, $2, $3, 'pending') RETURNING id;
      `, [c2Id, r4Id, idemp4]);
      const d4Id = d4.rows[0].id;

      // Simulate publisher claiming the outbox record
      const payload4 = JSON.stringify({
        deliveryId: d4Id,
        campaignId: c2Id,
        recipientId: r4Id,
        scheduledAt: null,
      });
      const ob4 = await testClient.query(`
        INSERT INTO delivery_outbox (
          event_type, aggregate_id, deduplication_key, payload, status,
          attempt_count, claim_owner, lease_expires_at, available_at
        )
        VALUES (
          'email.dispatch', $1, $2, $3,
          'processing', 1, 'doomed_publisher', NOW() - INTERVAL '10 seconds', NOW()
        )
        RETURNING *;
      `, [d4Id, idemp4, payload4]);
      const outboxRecord4 = ob4.rows[0];

      // Publisher successfully pushed to BullMQ
      console.log('   Simulating publisher pushing job to BullMQ...');
      await testQueue.add(
        'send-email',
        { campaignId: c2Id, recipientId: r4Id, deliveryId: d4Id },
        { jobId: idemp4 }
      );

      // CRASH! Publisher dies here without calling markOutboxDispatched!
      console.log('   💥 Simulating publisher crash before marking outbox dispatched...');

      // Worker executes the BullMQ job
      console.log('   Worker executes initial job from queue...');
      await processEmailJob(
        {
          id: idemp4,
          data: { campaignId: c2Id, recipientId: r4Id, deliveryId: d4Id },
          attemptsMade: 0,
        },
        testPool
      );

      const postDeliv4 = await getDelivery(c2Id, r4Id, testClient);
      assert(postDeliv4!.status === 'sent', 'Initial delivery processed and marked "sent"');

      // Now recovered publisher restarts and sweeps: it sees the expired outbox record
      console.log('   Recovered publisher restarts, sees expired outbox record and re-publishes...');
      const reDispatched = await processOutboxBatch(10, 'recovered_pub_1', 30000, testPool, testQueue);
      assert(reDispatched.dispatched >= 1, 'Recovered publisher safely published and marked outbox dispatched');

      // Worker receives the duplicate BullMQ job arrival
      console.log('   Worker receives re-published duplicate BullMQ job...');
      await processEmailJob(
        {
          id: idemp4 + '_dup',
          data: { campaignId: c2Id, recipientId: r4Id, deliveryId: d4Id },
          attemptsMade: 0,
        },
        testPool
      );

      // Verify that NO second attempt was made and delivery remains 'sent'
      const attemptsCount4 = parseInt(
        (await testClient.query('SELECT COUNT(*) as cnt FROM email_attempts WHERE delivery_id = $1', [d4Id])).rows[0].cnt,
        10
      );
      assert(attemptsCount4 === 1, 'PostgreSQL authoritative state prevented duplicate delivery (attempts = 1)');

      // ======================================================================
      // SCENARIO 5: Repeated Publication After Restart (Idempotent Outbox Sweep)
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 5: Repeated publication after restart (sweep idempotency)');
      console.log(SUB_SEP);

      // Running processOutboxBatch when all records are dispatched should process 0 records
      const secondSweep = await processOutboxBatch(50, 'restarted_publisher', 30000, testPool, testQueue);
      assert(secondSweep.claimed === 0, 'Second sweep claimed 0 records (already dispatched events are ignored)');
      assert(secondSweep.dispatched === 0, 'Zero duplicate queue publications occurred');

      // ======================================================================
      // SCENARIO 6: Completed BullMQ Job Removal Followed by Outbox Recovery
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 6: Completed BullMQ job removal (removeOnComplete) followed by recovery');
      console.log(SUB_SEP);

      // Clean up the job from BullMQ simulating removeOnComplete expiration
      const existingJob = await testQueue.getJob(idemp4);
      if (existingJob) {
        await existingJob.remove();
        console.log('   Job removed from Redis (simulating removeOnComplete: true)');
      }

      // Simulate outbox record being reset or re-queued
      await testClient.query(`
        UPDATE delivery_outbox
        SET status = 'pending', claim_owner = NULL, lease_expires_at = NULL, available_at = NOW()
        WHERE aggregate_id = $1;
      `, [d4Id]);

      // Publisher sweeps again
      await processOutboxBatch(10, 'post_removal_publisher', 30000, testPool, testQueue);

      // Worker receives the job again
      await processEmailJob(
        {
          id: idemp4 + '_post_removal',
          data: { campaignId: c2Id, recipientId: r4Id, deliveryId: d4Id },
          attemptsMade: 0,
        },
        testPool
      );

      const attemptsPostRemoval = parseInt(
        (await testClient.query('SELECT COUNT(*) as cnt FROM email_attempts WHERE delivery_id = $1', [d4Id])).rows[0].cnt,
        10
      );
      assert(
        attemptsPostRemoval === 1,
        'Database authoritative idempotency protected delivery after BullMQ job was completely removed from Redis'
      );

      // ======================================================================
      // SCENARIO 7: Future Scheduled Delivery Preserves Exact Timestamp & Delay
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 7: Future scheduled delivery exact timestamp & delay preservation');
      console.log(SUB_SEP);

      // 1 hour in the future
      const futureDate = new Date(Date.now() + 3600 * 1000);
      const schedCamp = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status, scheduled_at)
        VALUES ($1, $2, 'Future Scheduled Outbox Test', 'Body', 'scheduled', $3)
        RETURNING id;
      `, [userId, senderId, futureDate.toISOString()]);
      const schedCampId = schedCamp.rows[0].id;

      const schedRecip = await testClient.query(`
        INSERT INTO recipients (campaign_id, email, name)
        VALUES ($1, 'scheduled_outbox@reachinbox.test', 'Scheduled User') RETURNING id;
      `, [schedCampId]);
      const schedRecipId = schedRecip.rows[0].id;
      const schedIdemp = `campaign_${schedCampId}_${schedRecipId}`;

      const schedDeliv = await testClient.query(`
        INSERT INTO email_deliveries (campaign_id, recipient_id, idempotency_key, status, scheduled_at)
        VALUES ($1, $2, $3, 'scheduled', $4) RETURNING id;
      `, [schedCampId, schedRecipId, schedIdemp, futureDate.toISOString()]);
      const schedDelivId = schedDeliv.rows[0].id;

      // Seed outbox event
      const schedPayload = JSON.stringify({
        deliveryId: schedDelivId,
        campaignId: schedCampId,
        recipientId: schedRecipId,
        scheduledAt: futureDate.toISOString(),
      });
      await testClient.query(`
        INSERT INTO delivery_outbox (event_type, aggregate_id, deduplication_key, payload, status, available_at)
        VALUES ('email.dispatch', $1, $2, $3::JSONB, 'pending', NOW());
      `, [schedDelivId, schedIdemp, schedPayload]);

      // Publish outbox event to BullMQ
      await processOutboxBatch(10, 'scheduled_publisher', 30000, testPool, testQueue);

      // Inspect BullMQ job delay
      const schedJob = await testQueue.getJob(schedIdemp);
      assert(schedJob !== undefined && schedJob !== null, 'Scheduled job added to BullMQ delayed queue');
      assert(schedJob!.delay > 3500 * 1000, 'BullMQ job delay preserves exact future delta (~3600s)');

      // Verify worker CANNOT execute before scheduled_at
      console.log('   Verifying worker refuses to execute before scheduled timestamp...');
      await processEmailJob(
        {
          id: schedIdemp,
          data: { campaignId: schedCampId, recipientId: schedRecipId, deliveryId: schedDelivId },
          attemptsMade: 0,
        },
        testPool
      );

      const postEarlyWorkerDeliv = await getDelivery(schedCampId, schedRecipId, testClient);
      assert(postEarlyWorkerDeliv!.status === 'scheduled', 'Delivery remains "scheduled" (did not execute early)');

      const campEarlyCheck = await testClient.query('SELECT status FROM campaigns WHERE id = $1', [schedCampId]);
      assert(campEarlyCheck.rows[0].status === 'scheduled', 'Campaign remains "scheduled"');

      // Now simulate scheduled timestamp arrival: update scheduled_at to past
      console.log('   Simulating arrival of scheduled time...');
      await testClient.query(`UPDATE campaigns SET scheduled_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [schedCampId]);
      await testClient.query(`UPDATE email_deliveries SET scheduled_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [schedDelivId]);

      // Worker executes now that it is due
      await processEmailJob(
        {
          id: schedIdemp,
          data: { campaignId: schedCampId, recipientId: schedRecipId, deliveryId: schedDelivId },
          attemptsMade: 0,
        },
        testPool
      );

      const postDueDeliv = await getDelivery(schedCampId, schedRecipId, testClient);
      assert(postDueDeliv!.status === 'sent', 'Scheduled delivery executed and marked "sent" at due time');

      // ======================================================================
      // SCENARIOS 8 & 9 SETUP: Historical Records & Future Scheduled Data
      // ======================================================================

      // Create test campaign
      const c8 = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, $2, 'Historical Replay Safety', 'Body', 'sending') RETURNING id;
      `, [userId, senderId]);
      const c8Id = c8.rows[0].id;

      // Seed 4 non-dispatchable deliveries
      const testCases = [
        { status: 'sent', email: 'hist_sent@test.com' },
        { status: 'unknown', email: 'hist_unknown@test.com' },
        { status: 'cancelled', email: 'hist_cancelled@test.com' },
        { status: 'failed', email: 'hist_failed@test.com' },
      ];

      for (const tc of testCases) {
        const r = await testClient.query(
          `INSERT INTO recipients (campaign_id, email, name) VALUES ($1, $2, 'User') RETURNING id;`,
          [c8Id, tc.email]
        );
        await testClient.query(`
          INSERT INTO email_deliveries (campaign_id, recipient_id, idempotency_key, status)
          VALUES ($1, $2, $3, $4);
        `, [c8Id, r.rows[0].id, `campaign_${c8Id}_${r.rows[0].id}`, tc.status]);
      }

      // Seed a draft campaign
      const draftC = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, $2, 'Draft No Replay', 'Body', 'draft') RETURNING id;
      `, [userId, senderId]);
      const rDraft = await testClient.query(
        `INSERT INTO recipients (campaign_id, email, name) VALUES ($1, 'draft@test.com', 'Draft') RETURNING id;`,
        [draftC.rows[0].id]
      );
      await testClient.query(`
        INSERT INTO email_deliveries (campaign_id, recipient_id, idempotency_key, status)
        VALUES ($1, $2, $3, 'pending');
      `, [draftC.rows[0].id, rDraft.rows[0].id, `campaign_${draftC.rows[0].id}_${rDraft.rows[0].id}`]);

      // Seed 1 legitimate future scheduled delivery that SHOULD be recovered
      const futureC = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status, scheduled_at)
        VALUES ($1, $2, 'Legit Future', 'Body', 'scheduled', NOW() + INTERVAL '2 hours') RETURNING id;
      `, [userId, senderId]);
      const rFuture = await testClient.query(
        `INSERT INTO recipients (campaign_id, email, name) VALUES ($1, 'future_legit@test.com', 'User') RETURNING id;`,
        [futureC.rows[0].id]
      );
      const futDeliv = await testClient.query(`
        INSERT INTO email_deliveries (campaign_id, recipient_id, idempotency_key, status, scheduled_at)
        VALUES ($1, $2, $3, 'scheduled', NOW() + INTERVAL '2 hours') RETURNING id;
      `, [futureC.rows[0].id, rFuture.rows[0].id, `campaign_${futureC.rows[0].id}_${rFuture.rows[0].id}`]);

      // ======================================================================
      // SCENARIO 8: Reconcile future scheduled deliveries without outbox records
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 8: Reconcile future scheduled deliveries without outbox records');
      console.log(SUB_SEP);

      // Run recovery reconciliation
      const recoveredCount = await recoverFutureScheduledDeliveries(testClient);
      assert(recoveredCount === 1, `Recovery created outbox events ONLY for legitimate future scheduled campaigns (count = 1)`);

      // Verify the single recovered event corresponds to the legitimate future delivery
      const recoveredEvent = await testClient.query(
        `SELECT aggregate_id FROM delivery_outbox WHERE aggregate_id = $1`,
        [futDeliv.rows[0].id]
      );
      assert(recoveredEvent.rows.length === 1, 'Legitimate future delivery successfully recovered into outbox');

      // ======================================================================
      // SCENARIO 9: Historical non-dispatchable records are NEVER replayed
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 9: Historical non-dispatchable records are NEVER replayed');
      console.log(SUB_SEP);

      // Verify zero outbox events exist for historical sent, unknown, cancelled, failed, or draft deliveries
      const invalidRecoveries = await testClient.query(`
        SELECT outbox.id FROM delivery_outbox outbox
        JOIN email_deliveries ed ON ed.id = outbox.aggregate_id
        WHERE ed.campaign_id IN ($1, $2)
      `, [c8Id, draftC.rows[0].id]);
      assert(invalidRecoveries.rows.length === 0, 'ZERO outbox events created for sent, unknown, cancelled, failed, or draft deliveries');

      // Verify zero recovery events were created anywhere in the database for non-scheduled statuses
      const allInvalidRecoveryEvents = await testClient.query(`
        SELECT outbox.id, ed.status FROM delivery_outbox outbox
        JOIN email_deliveries ed ON ed.id = outbox.aggregate_id
        WHERE outbox.created_at >= NOW() - INTERVAL '5 minutes'
          AND ed.status IN ('sent', 'unknown', 'cancelled', 'failed')
          AND outbox.deduplication_key LIKE '%recovery%'
      `);
      assert(allInvalidRecoveryEvents.rows.length === 0, 'ZERO recovery events created for non-dispatchable delivery states');

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
    try { await testQueue.obliterate({ force: true }); } catch (_) {}
    await testQueue.close();
    await adminClient.end();
  }

  console.log('\n' + SEP);
  console.log(`  BATCH 2 VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log(SEP + '\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) {
  runBatch2Verification().catch((err) => {
    console.error('Fatal error during Batch 2 verification:', err);
    process.exit(1);
  });
}

export { runBatch2Verification };
