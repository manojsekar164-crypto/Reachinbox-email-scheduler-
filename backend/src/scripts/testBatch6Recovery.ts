/**
 * src/scripts/testBatch6Recovery.ts
 *
 * Verification Suite for Batch 6 – Email Failure & Recovery Center.
 *
 * SAFETY INVARIANT:
 *  - Runs strictly against an isolated ephemeral database: `reachinbox_migration_test`.
 *  - Restores verified production backup: `reachinbox-pre-stage1.dump`.
 *  - Executes schema migrations (001–008) in the isolated database.
 *  - Tests all mandatory acceptance criteria (Batch 6 & Batch 6.1):
 *      1. User cannot access another user's failures (cross-tenant isolation).
 *      2. Failure listing and pagination.
 *      3. Attempt history preservation.
 *      4. Retry eligibility classification.
 *      5. Two concurrent manual retry requests cannot enqueue duplicate attempts.
 *      6. Sent delivery cannot be retried.
 *      7. Unknown delivery cannot be retried without explicit resolution.
 *      8. Confirmed accepted resolution does not fabricate SMTP metadata.
 *      9. Confirmed not-accepted resolution requires an audit record.
 *     10. Pause prevents new claims.
 *     11. Resume republishes eligible deliveries safely.
 *     12. Cancel prevents remaining dispatches.
 *     13. Atomic campaign cancellation commits all tables.
 *     14. Injected cancellation failure rolls back all tables completely.
 *     15. Concurrent cancellation requests remain idempotent.
 *     16. Pause racing with delivery claiming (row-locking synchronization).
 *     17. Cancellation racing with delivery claiming (row-locking synchronization).
 *     18. In-flight dispatches counted and active dispatches preserved.
 *     19. Strict preservation of sent and unknown deliveries across cancellation.
 *  - Cleans up and verifies production DB `reachinbox` remains 100% untouched.
 */

process.env.START_WORKER = 'false';
process.env.SEND_DELAY_TEST_MS = '0';
process.env.DISABLE_ES_INDEXING = 'true';

import { Client, Pool } from 'pg';
import { execSync } from 'child_process';
import { runMigrations } from '../db/migrate';
import { redis } from '../db/redis';
import { emailQueue } from '../queue/emailQueue';
import {
  listDeliveries,
  getDeliveryDetail,
  getDeliveryAttemptHistory,
  manualRetryDelivery,
  resolveUnknownDelivery,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  evaluateRetryEligibility,
} from '../services/recoveryService';
import { claimDelivery } from '../services/deliveryService';
import { processEmailJob } from '../workers/emailWorker';

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

async function runBatch6Verification(): Promise<void> {
  console.log('\n' + SEP);
  console.log('  BATCH 6 VERIFICATION: EMAIL FAILURE & RECOVERY CENTER');
  console.log('  Target Database: ' + TEST_DB_NAME + ' (Ephemeral Isolated Test DB)');
  console.log('  Production DB:   reachinbox (UNTOUCHED)');
  console.log(SEP + '\n');

  const adminClient = new Client({
    ...BASE_PG_CONFIG,
    database: 'postgres',
  });
  await adminClient.connect();

  try {
    // 1. Prepare isolated test database
    console.log('1. Preparing isolated ephemeral test database...');
    await adminClient.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();
    `);
    await adminClient.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminClient.query(`CREATE DATABASE ${TEST_DB_NAME};`);
    console.log(`   Database "${TEST_DB_NAME}" created.\n`);

    // 2. Restore backup
    console.log('2. Restoring pre-stage1 backup into isolated database...');
    const backupContainerPath = '/tmp/reachinbox-pre-stage1.dump';
    execSync(
      `docker exec reachinbox_postgres pg_restore -U postgres -d ${TEST_DB_NAME} --no-owner --no-privileges ${backupContainerPath}`,
      { stdio: 'pipe' }
    );
    console.log('   pg_restore completed successfully.\n');

    // 3. Apply schema migrations
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
      console.log(`   Migrations applied: ${migrationResult.applied.length}, skipped: ${migrationResult.skipped.length}`);
      assert(
        migrationResult.applied.includes('008_create_operator_resolutions_schema.sql'),
        'Migration 008 (operator resolutions schema) applied successfully'
      );

      // Clean BullMQ queue backlog
      await emailQueue.obliterate({ force: true });

      // Clean Redis rate-limit and spacing keys
      const testKeys = await redis.keys('rate-limit:*');
      if (testKeys.length > 0) {
        await redis.del(...testKeys);
      }
      await redis.del('email-send:global:last-send');

      // 4. Seed test fixtures
      console.log('\n4. Seeding multi-tenant test fixtures in isolated database...');

      // Create User A
      const userARes = await testClient.query(
        `INSERT INTO users (email, name) VALUES ('user_a@test.com', 'User A') RETURNING id;`
      );
      const userAId = userARes.rows[0].id;

      // Create User B (for cross-tenant security verification)
      const userBRes = await testClient.query(
        `INSERT INTO users (email, name) VALUES ('user_b@test.com', 'User B') RETURNING id;`
      );
      const userBId = userBRes.rows[0].id;

      // Senders
      const senderARes = await testClient.query(
        `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, hourly_limit)
         VALUES ($1, 'Sender A', 'sender_a@test.com', 'smtp.reachinbox.test', 587, false, 'user_a', 'supersecret_a', 50)
         RETURNING id;`,
        [userAId]
      );
      const senderAId = senderARes.rows[0].id;

      const senderBRes = await testClient.query(
        `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, hourly_limit)
         VALUES ($1, 'Sender B', 'sender_b@test.com', 'smtp.reachinbox.test', 587, false, 'user_b', 'supersecret_b', 50)
         RETURNING id;`,
        [userBId]
      );
      const senderBId = senderBRes.rows[0].id;

      // User A Campaigns
      const campA1Res = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
         VALUES ($1, $2, 'Campaign A1 - Product Launch', 'Hello world', 'sending', 20)
         RETURNING id;`,
        [userAId, senderAId]
      );
      const campA1Id = campA1Res.rows[0].id;

      const campA2Res = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
         VALUES ($1, $2, 'Campaign A2 - Newsletter', 'Newsletter content', 'sending', 20)
         RETURNING id;`,
        [userAId, senderAId]
      );
      const campA2Id = campA2Res.rows[0].id;

      // User B Campaign
      const campBRes = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
         VALUES ($1, $2, 'Campaign B - Confidential', 'Classified content', 'sending', 20)
         RETURNING id;`,
        [userBId, senderBId]
      );
      const campBId = campBRes.rows[0].id;

      // Recipients
      async function createRecipientAndDelivery(
        campaignId: string,
        senderId: string,
        email: string,
        name: string,
        status: string,
        attemptCount = 1,
        lastError: string | null = null,
        errorClassification: string | null = null,
        smtpResponseCode: string | null = null,
        smtpMessageId: string | null = null
      ): Promise<{ recipientId: string; deliveryId: string }> {
        const rRes = await testClient.query(
          `INSERT INTO recipients (campaign_id, email, name, status) VALUES ($1, $2, $3, 'pending') RETURNING id;`,
          [campaignId, email, name]
        );
        const recipientId = rRes.rows[0].id;

        const dRes = await testClient.query(
          `INSERT INTO email_deliveries (
             campaign_id, recipient_id, sender_id, idempotency_key, status, attempt_count, last_error, smtp_message_id
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id;`,
          [
            campaignId,
            recipientId,
            senderId,
            `campaign_${campaignId}_${recipientId}`,
            status,
            attemptCount,
            lastError,
            smtpMessageId,
          ]
        );
        const deliveryId = dRes.rows[0].id;

        if (attemptCount > 0) {
          for (let i = 1; i <= attemptCount; i++) {
            const attemptStatus = i === attemptCount ? status : 'failed';
            await testClient.query(
              `INSERT INTO email_attempts (
                 delivery_id, attempt_number, status, sender_id, smtp_response_code, smtp_message_id, error_classification, error_message, attempted_at, completed_at
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() - ($9 || ' minutes')::INTERVAL, NOW() - ($9 || ' minutes')::INTERVAL);`,
              [
                deliveryId,
                i,
                attemptStatus === 'retry_wait' ? 'failed' : attemptStatus,
                senderId,
                smtpResponseCode,
                smtpMessageId,
                errorClassification,
                lastError,
                attemptCount - i,
              ]
            );
          }
        }

        return { recipientId, deliveryId };
      }

      // Seed diverse deliveries for User A
      const delTransient = await createRecipientAndDelivery(
        campA1Id,
        senderAId,
        'transient@reachinbox.test',
        'Transient Contact',
        'failed',
        2,
        'Transient SMTP failure 451 4.3.0 Mailbox busy',
        'transient_rejection',
        '451'
      );

      const delPerm = await createRecipientAndDelivery(
        campA1Id,
        senderAId,
        'perm@reachinbox.test',
        'Permanent Contact',
        'failed',
        1,
        'Permanent SMTP rejection 550 5.1.1 User unknown',
        'permanent_rejection',
        '550'
      );

      const delConn = await createRecipientAndDelivery(
        campA1Id,
        senderAId,
        'conn@reachinbox.test',
        'Connection Contact',
        'failed',
        1,
        'connect ECONNREFUSED 127.0.0.1:25',
        'connection_failure',
        null
      );

      const delUnknown = await createRecipientAndDelivery(
        campA1Id,
        senderAId,
        'unknown@reachinbox.test',
        'Unknown Contact',
        'unknown',
        1,
        'Connection timeout waiting for SMTP 250 OK response',
        'ambiguous_outcome',
        null
      );

      const delSent = await createRecipientAndDelivery(
        campA1Id,
        senderAId,
        'sent@reachinbox.test',
        'Sent Contact',
        'sent',
        1,
        null,
        'confirmed_acceptance',
        '250',
        '<msg-12345@reachinbox.test>'
      );

      const delCancelled = await createRecipientAndDelivery(
        campA1Id,
        senderAId,
        'cancelled@reachinbox.test',
        'Cancelled Contact',
        'cancelled',
        0,
        'Campaign cancelled by operator'
      );

      const delMaxAttempts = await createRecipientAndDelivery(
        campA1Id,
        senderAId,
        'max_attempts@reachinbox.test',
        'Max Attempts Contact',
        'failed',
        5, // Maximum 5 attempts
        'Transient SMTP failure 451',
        'transient_rejection',
        '451'
      );

      // Seed deliveries for User A Campaign 2
      const delA2 = await createRecipientAndDelivery(
        campA2Id,
        senderAId,
        'a2_failed@reachinbox.test',
        'A2 Contact',
        'failed',
        1,
        'Connection failure',
        'connection_failure'
      );

      // Seed deliveries for User B (Tenant B)
      const delUserB = await createRecipientAndDelivery(
        campBId,
        senderBId,
        'victim@userb.test',
        'Victim User B',
        'failed',
        1,
        'User B private failure',
        'permanent_rejection'
      );

      const delUnknownUserB = await createRecipientAndDelivery(
        campBId,
        senderBId,
        'unknown@userb.test',
        'Victim Unknown B',
        'unknown',
        1,
        'User B private unknown',
        'ambiguous_outcome'
      );

      // ---------------------------------------------------------------------
      // TEST 1: User Cannot Access Another User's Failures (Cross-Tenant Security)
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 1: User Cannot Access Another User\'s Failures');
      console.log(SUB_SEP);

      // User A listing
      const userAList = await listDeliveries({ userId: userAId }, testClient);
      assert(
        userAList.deliveries.length > 0,
        'User A listing returns User A deliveries'
      );
      assert(
        userAList.deliveries.every((d) => d.campaign_id === campA1Id || d.campaign_id === campA2Id),
        'All returned deliveries belong exclusively to User A campaigns'
      );
      assert(
        !userAList.deliveries.some((d) => d.id === delUserB.deliveryId),
        'User B failure record is completely invisible in User A listing'
      );

      // User A accessing User B delivery detail -> must reject
      let accessDeniedDetail = false;
      try {
        await getDeliveryDetail(delUserB.deliveryId, userAId, testClient);
      } catch (err: any) {
        if (err.statusCode === 404 || err.message.includes('not found or access denied')) {
          accessDeniedDetail = true;
        }
      }
      assert(accessDeniedDetail, 'User A cannot view details of User B delivery (404 Access Denied)');

      // User A attempting manual retry on User B delivery -> must reject
      let accessDeniedRetry = false;
      try {
        await manualRetryDelivery(delUserB.deliveryId, userAId, testPool);
      } catch (err: any) {
        if (err.statusCode === 404 || err.message.includes('not found or access denied')) {
          accessDeniedRetry = true;
        }
      }
      assert(accessDeniedRetry, 'User A cannot trigger manual retry on User B delivery (404 Access Denied)');

      // User A attempting operator resolution on User B delivery -> must reject
      let accessDeniedResolve = false;
      try {
        await resolveUnknownDelivery(delUnknownUserB.deliveryId, userAId, {
          decision: 'confirmed_accepted',
          reason: 'Attempted cross-tenant resolve',
        }, testPool);
      } catch (err: any) {
        if (err.statusCode === 404 || err.message.includes('not found or access denied')) {
          accessDeniedResolve = true;
        }
      }
      assert(accessDeniedResolve, 'User A cannot resolve unknown delivery belonging to User B (404 Access Denied)');

      // Verify no secrets leaked in sender info
      assert(
        userAList.deliveries.every((d: any) => d.sender_pass === undefined && d.smtp_pass === undefined),
        'Query sanitization never exposes SMTP passwords or credentials'
      );

      // ---------------------------------------------------------------------
      // TEST 2: Failure Listing, Filtering, and Pagination
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 2: Failure Listing, Multi-Criteria Filtering, and Pagination');
      console.log(SUB_SEP);

      // Filter by status: 'failed'
      const failedList = await listDeliveries({ userId: userAId, status: 'failed' }, testClient);
      assert(
        failedList.deliveries.every((d) => d.status === 'failed'),
        'Filtering by status=failed returns strictly failed deliveries'
      );
      assert(
        !failedList.deliveries.some((d) => d.status === 'unknown' || d.status === 'sent'),
        'Unknown and sent deliveries excluded from status=failed filter'
      );

      // Filter by status: 'unknown'
      const unknownList = await listDeliveries({ userId: userAId, status: 'unknown' }, testClient);
      assert(
        unknownList.deliveries.every((d) => d.status === 'unknown'),
        'Filtering by status=unknown returns strictly unknown deliveries'
      );

      // Filter by campaign
      const campA2List = await listDeliveries({ userId: userAId, campaignId: campA2Id }, testClient);
      assert(
        campA2List.deliveries.every((d) => d.campaign_id === campA2Id),
        'Filtering by campaignId returns deliveries strictly for that campaign'
      );

      // Filter by errorClassification: 'transient_rejection'
      const transientList = await listDeliveries({
        userId: userAId,
        errorClassification: 'transient_rejection',
      }, testClient);
      assert(
        transientList.deliveries.every((d) => d.latest_attempt?.error_classification === 'transient_rejection'),
        'Filtering by errorClassification returns strictly matching classifications'
      );

      // Pagination
      const page1 = await listDeliveries({ userId: userAId, limit: 2, page: 1 }, testClient);
      const page2 = await listDeliveries({ userId: userAId, limit: 2, page: 2 }, testClient);
      assert(page1.deliveries.length === 2, 'Page 1 respects limit = 2');
      assert(page2.deliveries.length === 2, 'Page 2 respects limit = 2');
      assert(
        page1.deliveries[0].id !== page2.deliveries[0].id,
        'Pagination delivers non-overlapping slices'
      );
      assert(page1.pagination.total > 2, 'Pagination metadata reports correct total count');
      assert(page1.pagination.has_next === true, 'Pagination metadata reports has_next = true');

      // ---------------------------------------------------------------------
      // TEST 3: Attempt History Preservation
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 3: Attempt History Preservation (Immutable Audit Log)');
      console.log(SUB_SEP);

      const delTransientDetail = await getDeliveryDetail(delTransient.deliveryId, userAId, testClient);
      assert(
        delTransientDetail.attempts.length === 2,
        'Complete attempt history retrieved (exactly 2 attempts for transient failure)'
      );
      assert(
        delTransientDetail.attempts[0].attempt_number === 1 &&
        delTransientDetail.attempts[1].attempt_number === 2,
        'Attempt history sorted stably by attempt_number ASC'
      );
      assert(
        delTransientDetail.attempts[1].smtp_response_code === '451',
        'Genuine SMTP response code 451 preserved in attempt audit record'
      );

      const separateHistory = await getDeliveryAttemptHistory(delTransient.deliveryId, userAId, testClient);
      assert(
        separateHistory.length === 2,
        'Dedicated getDeliveryAttemptHistory endpoint returns exact matching attempt history'
      );

      // ---------------------------------------------------------------------
      // TEST 4: Retry Eligibility Classification
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 4: Retry Eligibility Classification and Reasoning');
      console.log(SUB_SEP);

      // Transient failure -> eligible
      const elTransient = evaluateRetryEligibility(
        { status: 'failed', attempt_count: 2, deleted_at: null },
        { error_classification: 'transient_rejection', status: 'failed' }
      );
      assert(elTransient.is_eligible === true, 'Transient failure is eligible for manual retry');
      assert(elTransient.reason.includes('Transient SMTP error'), 'Eligibility reason describes transient error');

      // Connection failure -> eligible
      const elConn = evaluateRetryEligibility(
        { status: 'failed', attempt_count: 1, deleted_at: null },
        { error_classification: 'connection_failure', status: 'failed' }
      );
      assert(elConn.is_eligible === true, 'Connection failure is eligible for manual retry');

      // Permanent rejection -> NOT eligible
      const elPerm = evaluateRetryEligibility(
        { status: 'failed', attempt_count: 1, deleted_at: null },
        { error_classification: 'permanent_rejection', status: 'failed' }
      );
      assert(elPerm.is_eligible === false, 'Permanent rejection is NOT eligible for manual retry');
      assert(elPerm.reason.includes('permanent rejection'), 'Ineligibility reason explains permanent rejection');

      // Unknown outcome -> NOT eligible
      const elUnknown = evaluateRetryEligibility(
        { status: 'unknown', attempt_count: 1, deleted_at: null },
        { error_classification: 'ambiguous_outcome', status: 'unknown' }
      );
      assert(elUnknown.is_eligible === false, 'Unknown delivery is NOT eligible for manual retry without operator resolution');
      assert(elUnknown.reason.includes('uncertain'), 'Ineligibility reason explains uncertainty');

      // Sent delivery -> NOT eligible
      const elSent = evaluateRetryEligibility(
        { status: 'sent', attempt_count: 1, deleted_at: null }
      );
      assert(elSent.is_eligible === false, 'Sent delivery is NOT eligible for retry');

      // Cancelled delivery -> NOT eligible
      const elCancelled = evaluateRetryEligibility(
        { status: 'cancelled', attempt_count: 0, deleted_at: null }
      );
      assert(elCancelled.is_eligible === false, 'Cancelled delivery is NOT eligible for retry');

      // Max attempts exceeded -> NOT eligible
      const elMax = evaluateRetryEligibility(
        { status: 'failed', attempt_count: 5, deleted_at: null },
        { error_classification: 'transient_rejection' },
        'sending',
        5
      );
      assert(elMax.is_eligible === false, 'Exceeding max attempts is NOT eligible for retry');
      assert(elMax.max_attempts_reached === true, 'Max attempts reached flag is set');

      // ---------------------------------------------------------------------
      // TEST 5: Concurrent Manual Retries Cannot Enqueue Duplicate Attempts
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 5: Concurrent Manual Retries Cannot Enqueue Duplicate Attempts');
      console.log(SUB_SEP);

      // Create a fresh eligible failed delivery
      const freshFailed = await createRecipientAndDelivery(
        campA1Id,
        senderAId,
        'concurrent_retry@reachinbox.test',
        'Concurrent Contact',
        'failed',
        1,
        'Connection timeout',
        'connection_failure'
      );

      // Launch two concurrent manual retry requests
      const [res1, res2] = await Promise.allSettled([
        manualRetryDelivery(freshFailed.deliveryId, userAId, testPool, emailQueue),
        manualRetryDelivery(freshFailed.deliveryId, userAId, testPool, emailQueue),
      ]);

      const fulfilledCount = [res1, res2].filter((r) => r.status === 'fulfilled').length;
      const rejectedCount = [res1, res2].filter((r) => r.status === 'rejected').length;

      assert(
        fulfilledCount === 1,
        'Exactly ONE concurrent manual retry request succeeded'
      );
      assert(
        rejectedCount === 1,
        'Second concurrent retry request was cleanly rejected (prevented duplicate attempt)'
      );

      // Verify delivery is pending and outbox contains exactly 1 retry event
      const dAfterRetry = await testClient.query(
        `SELECT status FROM email_deliveries WHERE id = $1;`,
        [freshFailed.deliveryId]
      );
      assert(dAfterRetry.rows[0].status === 'pending', 'Delivery transitioned to pending status');

      const outboxEvents = await testClient.query(
        `SELECT id, deduplication_key FROM delivery_outbox
         WHERE (payload->>'deliveryId') = $1;`,
        [freshFailed.deliveryId]
      );
      assert(
        outboxEvents.rows.length === 1,
        'Exactly ONE outbox event was created for the authorized retry attempt'
      );
      assert(
        outboxEvents.rows[0].deduplication_key.includes('retry_'),
        'Deduplication key distinguishes authorized retry attempt'
      );

      // Subsequent duplicate retry while still pending must also be rejected
      let dupWhilePending = false;
      try {
        await manualRetryDelivery(freshFailed.deliveryId, userAId, testPool, emailQueue);
      } catch (err: any) {
        if (err.statusCode === 409 || err.message.includes('already queued or in progress')) {
          dupWhilePending = true;
        }
      }
      assert(dupWhilePending, 'Duplicate retry request rejected while outbox event is pending (409 Conflict)');

      // ---------------------------------------------------------------------
      // TEST 6: Sent Delivery Cannot Be Retried
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 6: Sent Delivery Cannot Be Retried');
      console.log(SUB_SEP);

      let sentRetryRejected = false;
      try {
        await manualRetryDelivery(delSent.deliveryId, userAId, testPool, emailQueue);
      } catch (err: any) {
        if (err.statusCode === 400 && err.message.includes('already been sent successfully')) {
          sentRetryRejected = true;
        }
      }
      assert(sentRetryRejected, 'Attempt to manually retry a sent delivery is rejected with HTTP 400');

      const sentCheck = await testClient.query(
        `SELECT status FROM email_deliveries WHERE id = $1;`,
        [delSent.deliveryId]
      );
      assert(sentCheck.rows[0].status === 'sent', 'Sent delivery status remains strictly "sent"');

      // ---------------------------------------------------------------------
      // TEST 7: Unknown Delivery Cannot Be Retried Without Explicit Resolution
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 7: Unknown Delivery Cannot Be Retried Without Explicit Resolution');
      console.log(SUB_SEP);

      let unknownRetryRejected = false;
      try {
        await manualRetryDelivery(delUnknown.deliveryId, userAId, testPool, emailQueue);
      } catch (err: any) {
        if (err.statusCode === 400 && err.message.includes('requires operator review')) {
          unknownRetryRejected = true;
        }
      }
      assert(
        unknownRetryRejected,
        'Attempt to manually retry an unresolved unknown delivery is rejected with HTTP 400'
      );

      const unknownCheck = await testClient.query(
        `SELECT status FROM email_deliveries WHERE id = $1;`,
        [delUnknown.deliveryId]
      );
      assert(unknownCheck.rows[0].status === 'unknown', 'Delivery status remains strictly "unknown"');

      // ---------------------------------------------------------------------
      // TEST 8: Confirmed Accepted Resolution Does Not Fabricate SMTP Metadata
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 8: Confirmed Accepted Resolution Does Not Fabricate SMTP Metadata');
      console.log(SUB_SEP);

      const resolveAcceptedRes = await resolveUnknownDelivery(
        delUnknown.deliveryId,
        userAId,
        {
          decision: 'confirmed_accepted',
          reason: 'Customer confirmed email was received in inbox',
        },
        testPool
      );

      assert(
        resolveAcceptedRes.success === true,
        'Operator resolution of unknown delivery succeeded'
      );
      assert(
        resolveAcceptedRes.new_status === 'sent',
        'Delivery status successfully reconciled to "sent"'
      );

      // Verify in DB
      const resolvedDelivery = await testClient.query(
        `SELECT status, sent_at, smtp_response_code, smtp_message_id, last_error
         FROM email_deliveries ed
         LEFT JOIN LATERAL (
           SELECT smtp_response_code FROM email_attempts ea WHERE ea.delivery_id = ed.id ORDER BY attempt_number DESC LIMIT 1
         ) ea ON true
         WHERE ed.id = $1;`,
        [delUnknown.deliveryId]
      );
      assert(
        resolvedDelivery.rows[0].status === 'sent',
        'Database status transitioned to "sent"'
      );
      assert(
        resolvedDelivery.rows[0].sent_at !== null,
        'sent_at timestamp is set'
      );
      assert(
        resolvedDelivery.rows[0].smtp_response_code === null,
        'SMTP response code is strictly NULL (never fabricated)'
      );
      assert(
        resolvedDelivery.rows[0].smtp_message_id === null,
        'SMTP message ID is strictly NULL (never fabricated)'
      );
      assert(
        resolvedDelivery.rows[0].last_error.includes('Customer confirmed email was received in inbox'),
        'Audit explanation preserved in delivery last_error'
      );

      // ---------------------------------------------------------------------
      // TEST 9: Confirmed Not-Accepted Resolution Requires Audit Record
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 9: Confirmed Not-Accepted Resolution Requires Audit Record and Authorizes Retry');
      console.log(SUB_SEP);

      // Create a second unknown delivery to test confirmed_not_accepted
      const delUnknown2 = await createRecipientAndDelivery(
        campA1Id,
        senderAId,
        'unknown2@reachinbox.test',
        'Unknown Contact 2',
        'unknown',
        1,
        'Connection dropped during DATA',
        'ambiguous_outcome'
      );

      // Empty reason must fail
      let emptyReasonFailed = false;
      try {
        await resolveUnknownDelivery(delUnknown2.deliveryId, userAId, {
          decision: 'confirmed_not_accepted',
          reason: '', // Empty reason
        }, testPool);
      } catch (err: any) {
        if (err.statusCode === 400 && err.message.includes('Mandatory resolution reason')) {
          emptyReasonFailed = true;
        }
      }
      assert(emptyReasonFailed, 'Operator resolution requires mandatory non-empty reason');

      // Valid confirmed_not_accepted resolution
      const resolveNotAcceptedRes = await resolveUnknownDelivery(
        delUnknown2.deliveryId,
        userAId,
        {
          decision: 'confirmed_not_accepted',
          reason: 'Recipient stated message never arrived and logs show connection aborted before DATA complete',
        },
        testPool
      );

      assert(
        resolveNotAcceptedRes.new_status === 'failed',
        'Delivery transitioned to "failed" after confirmed_not_accepted resolution'
      );

      // Verify audit record exists in delivery_resolutions
      const resolutionAudit = await testClient.query(
        `SELECT * FROM delivery_resolutions WHERE delivery_id = $1;`,
        [delUnknown2.deliveryId]
      );
      assert(
        resolutionAudit.rows.length === 1,
        'Immutable audit record persisted in delivery_resolutions table'
      );
      assert(
        resolutionAudit.rows[0].decision === 'confirmed_not_accepted',
        'Audit record preserves operator decision'
      );
      assert(
        resolutionAudit.rows[0].user_id === userAId,
        'Audit record preserves operator user ID'
      );
      assert(
        resolutionAudit.rows[0].reason.includes('Recipient stated message never arrived'),
        'Audit record preserves mandatory operator reasoning'
      );

      // Delivery is now eligible for manual retry
      const detailAfterResolution = await getDeliveryDetail(delUnknown2.deliveryId, userAId, testClient);
      assert(
        detailAfterResolution.retry_eligibility.is_eligible === true,
        'Delivery is now eligible for manual retry following operator resolution'
      );

      // Execute manual retry
      const retryAfterResolve = await manualRetryDelivery(delUnknown2.deliveryId, userAId, testPool, emailQueue);
      assert(
        retryAfterResolve.success === true,
        'Manual retry authorized and executed for resolved delivery'
      );

      // ---------------------------------------------------------------------
      // TEST 10: Pause Prevents New Claims and Reports In-Flight Work
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 10: Pause Campaign Prevents New Claims');
      console.log(SUB_SEP);

      // Create a fresh campaign with pending delivery
      const campPauseRes = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
         VALUES ($1, $2, 'Pause Campaign Test', 'Content', 'sending', 20)
         RETURNING id;`,
        [userAId, senderAId]
      );
      const campPauseId = campPauseRes.rows[0].id;

      const delPause = await createRecipientAndDelivery(
        campPauseId,
        senderAId,
        'pause_target@reachinbox.test',
        'Pause Target',
        'pending',
        0
      );

      // Pause campaign
      const pauseRes = await pauseCampaign(campPauseId, userAId, testClient);
      assert(pauseRes.status === 'paused', 'Campaign status updated to "paused"');

      // Attempt to claim delivery while campaign is paused -> must return null
      const claimWhilePaused = await claimDelivery({
        campaignId: campPauseId,
        recipientId: delPause.recipientId,
        claimOwner: 'test_worker_paused',
        dbClient: testClient,
      });
      assert(
        claimWhilePaused === null,
        'New delivery claim returns NULL while campaign is paused (dispatches safely halted)'
      );

      // Repeated pause is idempotent
      const pauseIdempotent = await pauseCampaign(campPauseId, userAId, testClient);
      assert(
        pauseIdempotent.status === 'paused',
        'Repeated pause request is idempotent and returns status "paused"'
      );

      // ---------------------------------------------------------------------
      // TEST 11: Resume Republishes Eligible Deliveries Safely
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 11: Resume Campaign Republishes Only Eligible Deliveries');
      console.log(SUB_SEP);

      // Add a sent delivery and an unknown delivery to the paused campaign to verify they are NEVER reactivated
      const delPauseSent = await createRecipientAndDelivery(
        campPauseId,
        senderAId,
        'pause_sent@reachinbox.test',
        'Pause Sent',
        'sent',
        1,
        null,
        'confirmed_acceptance',
        '250',
        '<already-sent@test>'
      );

      const delPauseUnknown = await createRecipientAndDelivery(
        campPauseId,
        senderAId,
        'pause_unknown@reachinbox.test',
        'Pause Unknown',
        'unknown',
        1,
        'Ambiguous outcome',
        'ambiguous_outcome'
      );

      // Resume campaign
      const resumeRes = await resumeCampaign(campPauseId, userAId, testPool, emailQueue);
      assert(resumeRes.status === 'sending', 'Campaign status updated to "sending"');
      assert(
        resumeRes.republished_count !== undefined && resumeRes.republished_count >= 1,
        'Resume created outbox events for eligible pending deliveries'
      );

      // Verify sent delivery was NOT reactivated
      const sentAfterResume = await testClient.query(
        `SELECT status FROM email_deliveries WHERE id = $1;`,
        [delPauseSent.deliveryId]
      );
      assert(
        sentAfterResume.rows[0].status === 'sent',
        'Sent delivery strictly remains "sent" after campaign resume'
      );

      // Verify unknown delivery was NOT reactivated
      const unknownAfterResume = await testClient.query(
        `SELECT status FROM email_deliveries WHERE id = $1;`,
        [delPauseUnknown.deliveryId]
      );
      assert(
        unknownAfterResume.rows[0].status === 'unknown',
        'Unknown delivery strictly remains "unknown" after campaign resume'
      );

      // Delivery can now be claimed again
      const claimAfterResume = await claimDelivery({
        campaignId: campPauseId,
        recipientId: delPause.recipientId,
        claimOwner: 'test_worker_resumed',
        dbClient: testClient,
      });
      assert(
        claimAfterResume !== null && claimAfterResume.status === 'sending',
        'Eligible delivery can now be claimed normally after campaign resume'
      );

      // Repeated resume is idempotent
      const resumeIdempotent = await resumeCampaign(campPauseId, userAId, testPool, emailQueue);
      assert(
        resumeIdempotent.status === 'sending',
        'Repeated resume request is idempotent and returns status "sending"'
      );

      // ---------------------------------------------------------------------
      // TEST 12: Cancel Campaign Prevents Remaining Dispatches
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 12: Cancel Campaign Prevents Remaining Dispatches');
      console.log(SUB_SEP);

      // Create a fresh campaign with pending delivery
      const campCancelRes = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
         VALUES ($1, $2, 'Cancel Campaign Test', 'Content', 'sending', 20)
         RETURNING id;`,
        [userAId, senderAId]
      );
      const campCancelId = campCancelRes.rows[0].id;

      const delCancelPending = await createRecipientAndDelivery(
        campCancelId,
        senderAId,
        'cancel_pending@reachinbox.test',
        'Cancel Pending',
        'pending',
        0
      );

      const delCancelSent = await createRecipientAndDelivery(
        campCancelId,
        senderAId,
        'cancel_sent@reachinbox.test',
        'Cancel Sent',
        'sent',
        1
      );

      const delCancelUnknown = await createRecipientAndDelivery(
        campCancelId,
        senderAId,
        'cancel_unknown@reachinbox.test',
        'Cancel Unknown',
        'unknown',
        1
      );

      // Cancel campaign
      const cancelRes = await cancelCampaign(campCancelId, userAId, testClient);
      assert(cancelRes.status === 'cancelled', 'Campaign status updated to "cancelled"');
      assert(cancelRes.cancelled_count === 1, 'Exactly 1 pending delivery cancelled');

      // Verify pending delivery transitioned to cancelled
      const dCancelCheck = await testClient.query(
        `SELECT status FROM email_deliveries WHERE id = $1;`,
        [delCancelPending.deliveryId]
      );
      assert(
        dCancelCheck.rows[0].status === 'cancelled',
        'Pending delivery transitioned to "cancelled"'
      );

      // Sent delivery remains sent
      const sCancelCheck = await testClient.query(
        `SELECT status FROM email_deliveries WHERE id = $1;`,
        [delCancelSent.deliveryId]
      );
      assert(
        sCancelCheck.rows[0].status === 'sent',
        'Sent delivery strictly remains "sent"'
      );

      // Unknown delivery remains unknown
      const uCancelCheck = await testClient.query(
        `SELECT status FROM email_deliveries WHERE id = $1;`,
        [delCancelUnknown.deliveryId]
      );
      assert(
        uCancelCheck.rows[0].status === 'unknown',
        'Unknown delivery strictly remains "unknown"'
      );

      // Claiming cancelled delivery must return null
      const claimCancelled = await claimDelivery({
        campaignId: campCancelId,
        recipientId: delCancelPending.recipientId,
        claimOwner: 'test_worker_cancelled',
        dbClient: testClient,
      });
      assert(
        claimCancelled === null,
        'Claiming delivery in cancelled campaign returns NULL'
      );

      // Repeated cancel is idempotent
      const cancelIdempotent = await cancelCampaign(campCancelId, userAId, testClient);
      assert(
        cancelIdempotent.status === 'cancelled',
        'Repeated cancel request is idempotent'
      );

      // ---------------------------------------------------------------------
      // TEST 13: Atomic Campaign Cancellation Commits All Tables
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 13: Atomic Campaign Cancellation Commits All Tables');
      console.log(SUB_SEP);

      const camp13Res = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
         VALUES ($1, $2, 'Batch 6.1 Atomic Cancel', 'Body', 'sending', 50)
         RETURNING id;`,
        [userAId, senderAId]
      );
      const camp13Id = camp13Res.rows[0].id;

      const del13Pending = await createRecipientAndDelivery(
        camp13Id,
        senderAId,
        'b61_pending@reachinbox.test',
        'Pending Del',
        'pending',
        0
      );
      const del13RetryWait = await createRecipientAndDelivery(
        camp13Id,
        senderAId,
        'b61_retry@reachinbox.test',
        'Retry Del',
        'retry_wait',
        1,
        'Temporary error',
        'transient_failure'
      );

      // Create an outbox event for this campaign
      await testClient.query(
        `INSERT INTO delivery_outbox (event_type, aggregate_id, deduplication_key, payload, status)
         VALUES ('send_email', $1, $2, '{"delivery_id": "dummy"}', 'pending');`,
        [camp13Id, `outbox_${camp13Id}_1`]
      );

      const res13 = await cancelCampaign(camp13Id, userAId, testPool);
      assert(res13.status === 'cancelled', 'Campaign status updated to cancelled');
      assert(res13.cancelled_count === 2, 'Both pending and retry_wait deliveries cancelled');

      // Verify campaign record
      const c13 = await testClient.query(`SELECT status FROM campaigns WHERE id = $1;`, [camp13Id]);
      assert(c13.rows[0].status === 'cancelled', 'Campaign status committed as cancelled');

      // Verify delivery records
      const d13Pending = await testClient.query(
        `SELECT status, claim_owner, lease_expires_at, last_error FROM email_deliveries WHERE id = $1;`,
        [del13Pending.deliveryId]
      );
      assert(d13Pending.rows[0].status === 'cancelled', 'Pending delivery committed as cancelled');
      assert(d13Pending.rows[0].claim_owner === null && d13Pending.rows[0].lease_expires_at === null, 'Claim owner and lease cleared');
      assert(d13Pending.rows[0].last_error === 'Campaign cancelled by operator', 'Last error updated to indicate operator cancellation');

      const d13Retry = await testClient.query(
        `SELECT status, claim_owner, lease_expires_at FROM email_deliveries WHERE id = $1;`,
        [del13RetryWait.deliveryId]
      );
      assert(d13Retry.rows[0].status === 'cancelled', 'Retry_wait delivery committed as cancelled');

      // Verify outbox records
      const o13 = await testClient.query(`SELECT status, last_error FROM delivery_outbox WHERE aggregate_id = $1;`, [camp13Id]);
      assert(o13.rows.length === 1 && o13.rows[0].status === 'failed', 'Pending outbox row failed');
      assert(o13.rows[0].last_error === 'Campaign cancelled by operator', 'Outbox record reflects operator cancellation');

      // ---------------------------------------------------------------------
      // TEST 14: Injected Cancellation Failure Rolls Back All Tables Completely
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 14: Injected Cancellation Failure Rolls Back All Tables Completely');
      console.log(SUB_SEP);

      const camp14Res = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
         VALUES ($1, $2, 'Batch 6.1 Rollback Test', 'Body', 'sending', 50)
         RETURNING id;`,
        [userAId, senderAId]
      );
      const camp14Id = camp14Res.rows[0].id;

      const del14 = await createRecipientAndDelivery(
        camp14Id,
        senderAId,
        'b61_rollback@reachinbox.test',
        'Rollback Del',
        'pending',
        0
      );

      await testClient.query(
        `INSERT INTO delivery_outbox (event_type, aggregate_id, deduplication_key, payload, status)
         VALUES ('send_email', $1, $2, '{"delivery_id": "dummy"}', 'pending');`,
        [camp14Id, `outbox_${camp14Id}_1`]
      );

      let rollbackErrorThrown = false;
      try {
        await cancelCampaign(camp14Id, userAId, testPool, { injectFailure: true });
      } catch (err: any) {
        if (err.message && err.message.includes('Injected failure during campaign cancellation transaction')) {
          rollbackErrorThrown = true;
        }
      }
      assert(rollbackErrorThrown, 'Injected cancellation failure caught as expected');

      // Verify complete rollback across all tables
      const c14 = await testClient.query(`SELECT status FROM campaigns WHERE id = $1;`, [camp14Id]);
      assert(c14.rows[0].status === 'sending', 'Campaign status rolled back to "sending"');

      const d14 = await testClient.query(`SELECT status FROM email_deliveries WHERE id = $1;`, [del14.deliveryId]);
      assert(d14.rows[0].status === 'pending', 'Delivery status rolled back to "pending"');

      const o14 = await testClient.query(`SELECT status FROM delivery_outbox WHERE aggregate_id = $1;`, [camp14Id]);
      assert(o14.rows[0].status === 'pending', 'Outbox status rolled back to "pending"');

      // ---------------------------------------------------------------------
      // TEST 15: Concurrent Cancellation Requests Remain Idempotent
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 15: Concurrent Cancellation Requests Remain Idempotent');
      console.log(SUB_SEP);

      const camp15Res = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
         VALUES ($1, $2, 'Batch 6.1 Concurrent Cancel', 'Body', 'sending', 50)
         RETURNING id;`,
        [userAId, senderAId]
      );
      const camp15Id = camp15Res.rows[0].id;

      await createRecipientAndDelivery(
        camp15Id,
        senderAId,
        'b61_concurrent_cancel@reachinbox.test',
        'Concurrent Cancel Del',
        'pending',
        0
      );

      const [cRes1, cRes2] = await Promise.all([
        cancelCampaign(camp15Id, userAId, testPool),
        cancelCampaign(camp15Id, userAId, testPool),
      ]);

      assert(cRes1.success && cRes2.success, 'Both concurrent cancellation calls succeed');
      assert(cRes1.status === 'cancelled' && cRes2.status === 'cancelled', 'Both return status "cancelled"');
      const totalCancelled = (cRes1.cancelled_count || 0) + (cRes2.cancelled_count || 0);
      assert(totalCancelled === 1, 'Exactly 1 delivery was cancelled across both concurrent requests');

      // ---------------------------------------------------------------------
      // TEST 16: Pause Racing with Delivery Claiming (Row-Locking Synchronization)
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 16: Pause Racing with Delivery Claiming (Row-Locking Synchronization)');
      console.log(SUB_SEP);

      const camp16Res = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
         VALUES ($1, $2, 'Batch 6.1 Pause Race', 'Body', 'sending', 50)
         RETURNING id;`,
        [userAId, senderAId]
      );
      const camp16Id = camp16Res.rows[0].id;

      const del16 = await createRecipientAndDelivery(
        camp16Id,
        senderAId,
        'b61_pause_race@reachinbox.test',
        'Pause Race Del',
        'pending',
        0
      );

      // Concurrently run claimDelivery and pauseCampaign
      const [claimResult16, pauseResult16] = await Promise.all([
        claimDelivery({
          campaignId: camp16Id,
          recipientId: del16.recipientId,
          claimOwner: 'worker_pause_race',
          dbClient: testPool,
        }),
        pauseCampaign(camp16Id, userAId, testPool),
      ]);

      assert(pauseResult16.status === 'paused', 'Campaign paused successfully');
      if (claimResult16 !== null) {
        assert(pauseResult16.in_flight_count === 1, 'Claimed delivery is reported in in_flight_count');
      } else {
        assert(pauseResult16.in_flight_count === 0, 'In-flight count is 0 as pause preceded claim');
      }

      // Subsequent claim MUST be rejected after campaign is paused
      const postPauseClaim = await claimDelivery({
        campaignId: camp16Id,
        recipientId: del16.recipientId,
        claimOwner: 'worker_post_pause',
        dbClient: testPool,
      });
      assert(postPauseClaim === null, 'No new delivery claim can succeed after campaign is paused');

      // ---------------------------------------------------------------------
      // TEST 17: Cancellation Racing with Delivery Claiming (Row-Locking Synchronization)
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 17: Cancellation Racing with Delivery Claiming (Row-Locking Synchronization)');
      console.log(SUB_SEP);

      const camp17Res = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
         VALUES ($1, $2, 'Batch 6.1 Cancel Race', 'Body', 'sending', 50)
         RETURNING id;`,
        [userAId, senderAId]
      );
      const camp17Id = camp17Res.rows[0].id;

      const del17 = await createRecipientAndDelivery(
        camp17Id,
        senderAId,
        'b61_cancel_race@reachinbox.test',
        'Cancel Race Del',
        'pending',
        0
      );

      const [claimResult17, cancelResult17] = await Promise.all([
        claimDelivery({
          campaignId: camp17Id,
          recipientId: del17.recipientId,
          claimOwner: 'worker_cancel_race',
          dbClient: testPool,
        }),
        cancelCampaign(camp17Id, userAId, testPool),
      ]);

      assert(cancelResult17.status === 'cancelled', 'Campaign cancelled successfully');
      if (claimResult17 !== null) {
        assert(cancelResult17.in_flight_count === 1, 'Claimed delivery is reported as in-flight during cancellation');
        const d17 = await testClient.query(`SELECT status FROM email_deliveries WHERE id = $1;`, [claimResult17.id]);
        assert(d17.rows[0].status === 'sending', 'In-flight sending delivery is preserved, not cancelled');
      } else {
        assert(cancelResult17.cancelled_count === 1, 'Delivery was cancelled by cancellation transaction');
        const d17 = await testClient.query(`SELECT status FROM email_deliveries WHERE id = $1;`, [del17.deliveryId]);
        assert(d17.rows[0].status === 'cancelled', 'Delivery transitioned to cancelled');
      }

      // Subsequent claim MUST be rejected after campaign is cancelled
      const postCancelClaim = await claimDelivery({
        campaignId: camp17Id,
        recipientId: del17.recipientId,
        claimOwner: 'worker_post_cancel',
        dbClient: testPool,
      });
      assert(postCancelClaim === null, 'No new delivery claim can succeed after campaign is cancelled');

      // ---------------------------------------------------------------------
      // TEST 18: In-Flight Dispatches Counted and Active Dispatches Preserved
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 18: In-Flight Dispatches Counted and Active Dispatches Preserved');
      console.log(SUB_SEP);

      const camp18Res = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
         VALUES ($1, $2, 'Batch 6.1 In-Flight Test', 'Body', 'sending', 50)
         RETURNING id;`,
        [userAId, senderAId]
      );
      const camp18Id = camp18Res.rows[0].id;

      // Create 2 active sending deliveries with future lease
      const r18Active1 = await testClient.query(
        `INSERT INTO recipients (campaign_id, email, name, status) VALUES ($1, 'a1@test.com', 'A1', 'pending') RETURNING id;`,
        [camp18Id]
      );
      const d18Active1 = await testClient.query(
        `INSERT INTO email_deliveries (campaign_id, recipient_id, sender_id, idempotency_key, status, claim_owner, lease_expires_at)
         VALUES ($1, $2, $3, 'key_18_a1', 'sending', 'worker_1', NOW() + INTERVAL '5 minutes')
         RETURNING id;`,
        [camp18Id, r18Active1.rows[0].id, senderAId]
      );

      const r18Active2 = await testClient.query(
        `INSERT INTO recipients (campaign_id, email, name, status) VALUES ($1, 'a2@test.com', 'A2', 'pending') RETURNING id;`,
        [camp18Id]
      );
      const d18Active2 = await testClient.query(
        `INSERT INTO email_deliveries (campaign_id, recipient_id, sender_id, idempotency_key, status, claim_owner, lease_expires_at)
         VALUES ($1, $2, $3, 'key_18_a2', 'sending', 'worker_2', NOW() + INTERVAL '5 minutes')
         RETURNING id;`,
        [camp18Id, r18Active2.rows[0].id, senderAId]
      );

      // Create 1 expired sending delivery (stale lease)
      const r18Expired = await testClient.query(
        `INSERT INTO recipients (campaign_id, email, name, status) VALUES ($1, 'exp@test.com', 'Exp', 'pending') RETURNING id;`,
        [camp18Id]
      );
      await testClient.query(
        `INSERT INTO email_deliveries (campaign_id, recipient_id, sender_id, idempotency_key, status, claim_owner, lease_expires_at)
         VALUES ($1, $2, $3, 'key_18_exp', 'sending', 'worker_3', NOW() - INTERVAL '5 minutes')
         RETURNING id;`,
        [camp18Id, r18Expired.rows[0].id, senderAId]
      );

      // Create 1 pending delivery
      await createRecipientAndDelivery(
        camp18Id,
        senderAId,
        'b61_pending_18@reachinbox.test',
        'Pending 18',
        'pending',
        0
      );

      const cancelRes18 = await cancelCampaign(camp18Id, userAId, testPool);
      assert(cancelRes18.status === 'cancelled', 'Campaign status updated to cancelled');
      assert(cancelRes18.in_flight_count === 2, 'Accurately reports exactly 2 active in-flight dispatches (expired excluded)');
      assert(cancelRes18.cancelled_count === 1, 'Only eligible pending delivery cancelled');

      // Verify active sending deliveries are preserved
      const checkA1 = await testClient.query(`SELECT status FROM email_deliveries WHERE id = $1;`, [d18Active1.rows[0].id]);
      const checkA2 = await testClient.query(`SELECT status FROM email_deliveries WHERE id = $1;`, [d18Active2.rows[0].id]);
      assert(checkA1.rows[0].status === 'sending' && checkA2.rows[0].status === 'sending', 'Active in-flight deliveries strictly preserved in "sending" status');

      // ---------------------------------------------------------------------
      // TEST 19: Strict Preservation of Sent and Unknown Deliveries across Cancellation
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 19: Strict Preservation of Sent and Unknown Deliveries across Cancellation');
      console.log(SUB_SEP);

      const camp19Res = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
         VALUES ($1, $2, 'Batch 6.1 Preserved Deliveries', 'Body', 'sending', 50)
         RETURNING id;`,
        [userAId, senderAId]
      );
      const camp19Id = camp19Res.rows[0].id;

      const del19Sent = await createRecipientAndDelivery(
        camp19Id,
        senderAId,
        'b61_sent@reachinbox.test',
        'Sent Del',
        'sent',
        1,
        null,
        null,
        '250 2.0.0 OK',
        '<msg19@reachinbox.test>'
      );
      await testClient.query(
        `UPDATE email_deliveries SET sent_at = NOW() - INTERVAL '1 hour' WHERE id = $1;`,
        [del19Sent.deliveryId]
      );

      const del19Unknown = await createRecipientAndDelivery(
        camp19Id,
        senderAId,
        'b61_unknown@reachinbox.test',
        'Unknown Del',
        'unknown',
        1,
        'Ambiguous SMTP outcome',
        'ambiguous_outcome'
      );

      const cancelRes19 = await cancelCampaign(camp19Id, userAId, testPool);
      assert(cancelRes19.status === 'cancelled', 'Campaign cancelled successfully');

      // Verify sent delivery is strictly untouched
      const check19Sent = await testClient.query(
        `SELECT status, sent_at, smtp_message_id FROM email_deliveries WHERE id = $1;`,
        [del19Sent.deliveryId]
      );
      assert(check19Sent.rows[0].status === 'sent', 'Sent delivery strictly remains "sent"');
      assert(check19Sent.rows[0].sent_at !== null, 'sent_at timestamp preserved');
      assert(check19Sent.rows[0].smtp_message_id === '<msg19@reachinbox.test>', 'smtp_message_id preserved');

      // Verify unknown delivery is strictly untouched
      const check19Unknown = await testClient.query(
        `SELECT status, last_error FROM email_deliveries WHERE id = $1;`,
        [del19Unknown.deliveryId]
      );
      assert(check19Unknown.rows[0].status === 'unknown', 'Unknown delivery strictly remains "unknown"');
      assert(check19Unknown.rows[0].last_error === 'Ambiguous SMTP outcome', 'Unknown last_error preserved');

    } finally {
      await testClient.end();
      await testPool.end();
    }
  } finally {
    // Drop test database cleanly
    console.log('\n5. Cleaning up isolated test database...');
    await adminClient.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();
    `);
    await adminClient.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminClient.end();
    console.log(`   Database "${TEST_DB_NAME}" dropped cleanly.`);
  }

  // Verify Production Database Integrity
  console.log('\n6. Verifying original database integrity...');
  const prodClient = new Client({
    ...BASE_PG_CONFIG,
    database: 'reachinbox',
  });
  await prodClient.connect();
  try {
    const prodTablesRes = await prodClient.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    const prodTables = prodTablesRes.rows.map((r) => r.table_name);
    assert(
      prodTables.length === 6 &&
        prodTables.includes('users') &&
        prodTables.includes('campaigns') &&
        prodTables.includes('recipients') &&
        prodTables.includes('email_logs') &&
        prodTables.includes('senders') &&
        prodTables.includes('slack_integrations'),
      'Original "reachinbox" database remains 100% UNTOUCHED (zero migrations executed against it)'
    );
  } finally {
    await prodClient.end();
  }

  console.log('\n' + SEP);
  console.log(`  BATCH 6 VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log(SEP + '\n');

  try {
    await emailQueue.close();
    await redis.quit();
  } catch (_) {}

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runBatch6Verification().catch((err) => {
  console.error('\n❌ Unhandled error in Batch 6 verification:', err);
  process.exit(1);
});
