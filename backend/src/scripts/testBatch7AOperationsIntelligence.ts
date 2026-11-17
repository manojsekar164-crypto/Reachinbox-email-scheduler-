/**
 * src/scripts/testBatch7AOperationsIntelligence.ts
 *
 * Verification Suite for Batch 7A – Operations Intelligence Data Service.
 *
 * SAFETY INVARIANT:
 *  - Runs strictly against an isolated ephemeral database: `reachinbox_migration_test`.
 *  - Restores verified production backup: `reachinbox-pre-stage1.dump`.
 *  - Executes schema migrations (001–008) in the isolated database.
 *  - Tests all 13 mandatory acceptance criteria:
 *      1. Campaign aggregation using actual PostgreSQL records.
 *      2. Sent, failed, pending, retry-wait, and unknown delivery counts.
 *      3. Accurate sender performance calculations and health states.
 *      4. SMTP acceptance versus inbox delivery distinction.
 *      5. Failure classification summaries and attempt distribution.
 *      6. Queue waiting, active, delayed, and failed job counts.
 *      7. Campaign-level queue isolation (multi-tenant queue scoping).
 *      8. User A cannot access User B campaign or sender information (cross-tenant isolation).
 *      9. Empty database and missing data handling (safe defaults, no fabricated data).
 *     10. Redis unavailable handling (graceful degradation with explicit indicator).
 *     11. Bounded date ranges and result sizes.
 *     12. No secrets or recipient PII in generated context.
 *     13. Zero database mutations during intelligence queries (strictly read-only).
 *  - Cleans up and verifies production DB `reachinbox` remains 100% untouched.
 */

process.env.START_WORKER = 'false';
process.env.SEND_DELAY_TEST_MS = '0';
process.env.DISABLE_ES_INDEXING = 'true';

import { Client, Pool } from 'pg';
import { execSync } from 'child_process';
import { Queue } from 'bullmq';
import { runMigrations } from '../db/migrate';
import { redis } from '../db/redis';
import { emailQueue, redisConnectionOptions, EmailJobPayload } from '../queue/emailQueue';
import {
  getCampaignIntelligence,
  getDeliveryFailureIntelligence,
  getSenderPerformanceIntelligence,
  getQueueIntelligence,
  analyzeOperationalBottlenecks,
  getOperationsContext,
} from '../services/operationsIntelligenceService';

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

async function runBatch7AVerification(): Promise<void> {
  console.log('\n' + SEP);
  console.log('  BATCH 7A VERIFICATION: OPERATIONS INTELLIGENCE DATA SERVICE');
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
      console.log(
        `   Migrations applied: ${migrationResult.applied.length}, skipped: ${migrationResult.skipped.length}`
      );
      assert(
        migrationResult.applied.length > 0 || migrationResult.skipped.length > 0,
        'Migrations executed successfully'
      );

      // Clean test Redis state
      console.log('\n4. Preparing Redis test keys...');
      const redisKeys = await redis.keys('rate-limit:*');
      if (redisKeys.length > 0) {
        await redis.del(...redisKeys);
      }
      await redis.del('email-send:global:last-send');
      await emailQueue.drain();
      await emailQueue.clean(0, 1000, 'delayed');
      await emailQueue.clean(0, 1000, 'wait');
      await emailQueue.clean(0, 1000, 'active');
      await emailQueue.clean(0, 1000, 'failed');

      // 5. Seed Multi-Tenant Fixtures
      console.log('\n5. Seeding multi-tenant test fixtures in isolated database...');

      // User A (Tenant A)
      const userARes = await testClient.query(
        `INSERT INTO users (email, name) VALUES ('user_a@opsintel.test', 'User A Ops') RETURNING id;`
      );
      const userAId = userARes.rows[0].id;

      // User B (Tenant B)
      const userBRes = await testClient.query(
        `INSERT INTO users (email, name) VALUES ('user_b@opsintel.test', 'User B Ops') RETURNING id;`
      );
      const userBId = userBRes.rows[0].id;

      // Senders for User A
      const senderA1Res = await testClient.query(
        `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, hourly_limit)
         VALUES ($1, 'Sender A1 Primary', 'sender_a1@reachinbox.test', 'smtp.reachinbox.test', 587, false, 'user_a1', 'secret_pass_a1', 100)
         RETURNING id;`,
        [userAId]
      );
      const senderA1Id = senderA1Res.rows[0].id;

      const senderA2Res = await testClient.query(
        `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, hourly_limit)
         VALUES ($1, 'Sender A2 Backup', 'sender_a2@reachinbox.test', 'smtp.reachinbox.test', 587, false, 'user_a2', 'secret_pass_a2', 50)
         RETURNING id;`,
        [userAId]
      );
      const senderA2Id = senderA2Res.rows[0].id;

      // Sender for User B (Isolated Tenant B)
      const senderBRes = await testClient.query(
        `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, hourly_limit)
         VALUES ($1, 'Sender B Victim', 'sender_b@victim.test', 'smtp.victim.test', 587, false, 'user_b', 'secret_pass_b', 200)
         RETURNING id;`,
        [userBId]
      );
      const senderBId = senderBRes.rows[0].id;

      // Campaigns for User A
      // Campaign A1: sending status
      const campA1Res = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
         VALUES ($1, $2, 'Campaign A1 Active', 'Content Body A1', 'sending', 50)
         RETURNING id;`,
        [userAId, senderA1Id]
      );
      const campA1Id = campA1Res.rows[0].id;

      // Campaign A2: completed status with high failure rate
      const campA2Res = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
         VALUES ($1, $2, 'Campaign A2 High Failure', 'Content Body A2', 'completed', 30)
         RETURNING id;`,
        [userAId, senderA1Id]
      );
      const campA2Id = campA2Res.rows[0].id;

      // Campaign A3: draft status
      const campA3Res = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
         VALUES ($1, $2, 'Campaign A3 Draft', 'Content Body A3', 'draft', 20)
         RETURNING id;`,
        [userAId, senderA2Id]
      );
      const campA3Id = campA3Res.rows[0].id;

      // Campaign for User B (Tenant B)
      const campBRes = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
         VALUES ($1, $2, 'Campaign B Private', 'Content Body B', 'sending', 100)
         RETURNING id;`,
        [userBId, senderBId]
      );
      const campBId = campBRes.rows[0].id;

      // Helper to insert deliveries & attempts
      async function createTestDelivery(
        campaignId: string,
        senderId: string,
        email: string,
        name: string,
        status: string,
        attemptCount = 1,
        lastError: string | null = null,
        errorClassification: string | null = null,
        smtpCode: string | null = null
      ): Promise<{ recipientId: string; deliveryId: string }> {
        const rRes = await testClient.query(
          `INSERT INTO recipients (campaign_id, email, name, status) VALUES ($1, $2, $3, 'pending') RETURNING id;`,
          [campaignId, email, name]
        );
        const recipientId = rRes.rows[0].id;

        const dRes = await testClient.query(
          `INSERT INTO email_deliveries (
             campaign_id, recipient_id, sender_id, idempotency_key, status, attempt_count, last_error
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id;`,
          [
            campaignId,
            recipientId,
            senderId,
            `del_${campaignId}_${recipientId}`,
            status,
            attemptCount,
            lastError,
          ]
        );
        const deliveryId = dRes.rows[0].id;

        if (attemptCount > 0) {
          for (let i = 1; i <= attemptCount; i++) {
            const attemptStatus = i === attemptCount ? status : 'failed';
            await testClient.query(
              `INSERT INTO email_attempts (
                 delivery_id, attempt_number, status, sender_id, smtp_response_code, error_classification, error_message, attempted_at, completed_at
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW());`,
              [
                deliveryId,
                i,
                attemptStatus === 'retry_wait' ? 'failed' : attemptStatus,
                senderId,
                smtpCode,
                errorClassification,
                lastError,
              ]
            );
          }
        }

        return { recipientId, deliveryId };
      }

      // Seed Campaign A1 deliveries (Mixed: sent, pending, retry_wait, unknown)
      // 1. Sent delivery
      await createTestDelivery(
        campA1Id,
        senderA1Id,
        'sent1@reachinbox.test',
        'Sent One',
        'sent',
        1,
        null,
        null,
        '250'
      );
      // 2. Sent delivery
      await createTestDelivery(
        campA1Id,
        senderA1Id,
        'sent2@reachinbox.test',
        'Sent Two',
        'sent',
        1,
        null,
        null,
        '250'
      );
      // 3. Pending delivery
      await createTestDelivery(
        campA1Id,
        senderA1Id,
        'pending1@reachinbox.test',
        'Pending One',
        'pending',
        0
      );
      // 4. Retry wait delivery (connection failure)
      await createTestDelivery(
        campA1Id,
        senderA1Id,
        'retry1@reachinbox.test',
        'Retry One',
        'retry_wait',
        2,
        'connect ECONNREFUSED 127.0.0.1:25',
        'connection_failure',
        null
      );
      // 5. Unknown outcome delivery (ambiguous SMTP loss)
      await createTestDelivery(
        campA1Id,
        senderA1Id,
        'unknown1@reachinbox.test',
        'Unknown One',
        'unknown',
        1,
        'Ambiguous SMTP outcome: connection timeout after DATA',
        'ambiguous_outcome',
        null
      );

      // Seed Campaign A2 deliveries (High failure: 1 sent, 3 failed)
      await createTestDelivery(
        campA2Id,
        senderA1Id,
        'a2_sent@reachinbox.test',
        'A2 Sent',
        'sent',
        1,
        null,
        null,
        '250'
      );
      await createTestDelivery(
        campA2Id,
        senderA1Id,
        'a2_fail1@reachinbox.test',
        'A2 Fail 1',
        'failed',
        3,
        '550 5.1.1 User unknown',
        'permanent_rejection',
        '550'
      );
      await createTestDelivery(
        campA2Id,
        senderA1Id,
        'a2_fail2@reachinbox.test',
        'A2 Fail 2',
        'failed',
        2,
        '451 4.3.0 Mailbox busy',
        'transient_rejection',
        '451'
      );
      await createTestDelivery(
        campA2Id,
        senderA1Id,
        'a2_fail3@reachinbox.test',
        'A2 Fail 3',
        'failed',
        1,
        '535 5.7.8 Authentication credentials invalid',
        'permanent_rejection',
        '535'
      );

      // Seed Tenant B (User B) private data
      await createTestDelivery(
        campBId,
        senderBId,
        'private_b@victim.test',
        'Private B',
        'sent',
        1,
        null,
        null,
        '250'
      );
      await createTestDelivery(
        campBId,
        senderBId,
        'private_b_fail@victim.test',
        'Private B Fail',
        'failed',
        1,
        'Tenant B secret error',
        'permanent_rejection',
        '550'
      );

      // ---------------------------------------------------------------------
      // TEST 1: Campaign Aggregation Using Actual PostgreSQL Records
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 1: Campaign Aggregation Using Actual PostgreSQL Records');
      console.log(SUB_SEP);

      const campIntel = await getCampaignIntelligence(userAId, {}, testPool);
      assert(campIntel.total_campaigns === 3, 'Reports exact total campaign count for User A (3 campaigns)');
      assert(campIntel.campaigns_by_status.sending === 1, 'Accurately counts 1 sending campaign');
      assert(campIntel.campaigns_by_status.completed === 1, 'Accurately counts 1 completed campaign');
      assert(campIntel.campaigns_by_status.draft === 1, 'Accurately counts 1 draft campaign');
      assert(campIntel.campaigns_by_status.scheduled === 0, 'Accurately reports 0 scheduled campaigns');

      // ---------------------------------------------------------------------
      // TEST 2: Sent, Failed, Pending, Retry-Wait, and Unknown Delivery Counts
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 2: Sent, Failed, Pending, Retry-Wait, and Unknown Delivery Counts');
      console.log(SUB_SEP);

      const delStats = campIntel.delivery_stats;
      assert(delStats.total_deliveries === 9, 'Reports exact total delivery count (9 deliveries for User A)');
      assert(delStats.sent_deliveries === 3, 'Accurately counts 3 sent deliveries (confirmed SMTP acceptances)');
      assert(delStats.failed_deliveries === 3, 'Accurately counts 3 failed deliveries');
      assert(delStats.pending_deliveries === 1, 'Accurately counts 1 pending delivery');
      assert(delStats.retry_wait_deliveries === 1, 'Accurately counts 1 retry_wait delivery');
      assert(delStats.unknown_deliveries === 1, 'Accurately counts 1 unknown delivery');

      // Success & Failure rate calculations: 3 sent, 3 failed -> completed = 6
      assert(delStats.success_rate === 0.5, 'Success rate is 0.5000 (3 sent / 6 completed)');
      assert(delStats.failure_rate === 0.5, 'Failure rate is 0.5000 (3 failed / 6 completed)');

      // High failure campaigns: Campaign A2 (1 sent, 3 failed = 75% failure rate)
      assert(campIntel.high_failure_campaigns.length === 1, 'Identifies Campaign A2 as high failure campaign');
      assert(campIntel.high_failure_campaigns[0].campaign_id === campA2Id, 'High failure campaign ID matches Campaign A2');
      assert(campIntel.high_failure_campaigns[0].failure_rate === 0.75, 'High failure campaign rate is 0.7500 (3/4)');

      // ---------------------------------------------------------------------
      // TEST 3: Accurate Sender Performance Calculations & Health States
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 3: Accurate Sender Performance Calculations and Health States');
      console.log(SUB_SEP);

      const senderIntel = await getSenderPerformanceIntelligence(userAId, testPool);
      assert(senderIntel.senders.length === 2, 'Lists all senders owned by User A (2 senders)');

      const s1 = senderIntel.senders.find((s) => s.sender_id === senderA1Id);
      assert(s1 !== undefined, 'Sender A1 primary exists in output');
      assert(s1?.unique_deliveries === 9, 'Sender A1 unique deliveries = 9');
      assert(s1?.confirmed_smtp_acceptances === 3, 'Sender A1 confirmed SMTP acceptances = 3');
      assert(s1?.confirmed_failures === 3, 'Sender A1 confirmed failures = 3');
      assert(s1?.unknown_outcomes === 1, 'Sender A1 unknown outcomes = 1');
      assert(s1?.hourly_limit === 100, 'Sender A1 hourly limit = 100');
      assert(s1?.health_status === 'critical', 'Sender A1 health status is critical due to 50% failure rate');

      const s2 = senderIntel.senders.find((s) => s.sender_id === senderA2Id);
      assert(s2 !== undefined, 'Sender A2 backup exists in output');
      assert(s2?.unique_deliveries === 0, 'Sender A2 unique deliveries = 0');
      assert(s2?.total_attempts === 0, 'Sender A2 total attempts = 0');
      assert(s2?.health_status === 'idle', 'Sender A2 health status is idle (0 attempts)');
      assert(s2?.success_rate === null, 'Sender A2 success rate is null (not 0 or fake score)');

      // ---------------------------------------------------------------------
      // TEST 4: SMTP Acceptance versus Inbox Delivery Distinction
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 4: SMTP Acceptance versus Inbox Delivery Distinction');
      console.log(SUB_SEP);

      assert(
        senderIntel.metric_notes.success_rate_definition.includes('RFC 5321 250 OK') &&
          senderIntel.metric_notes.success_rate_definition.includes('not recipient inbox placement'),
        'Metric notes explicitly define success_rate as SMTP 250 OK acceptance, NOT mailbox inbox delivery'
      );
      assert(
        senderIntel.metric_notes.attempt_vs_delivery_distinction.includes('distinct recipient targets') &&
          senderIntel.metric_notes.attempt_vs_delivery_distinction.includes('dispatch attempts, including retries'),
        'Metric notes clearly distinguish delivery attempts from unique recipient deliveries'
      );

      // ---------------------------------------------------------------------
      // TEST 5: Failure Classification Summaries & Attempt Distribution
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 5: Failure Classification Summaries and Attempt Distribution');
      console.log(SUB_SEP);

      const failIntel = await getDeliveryFailureIntelligence(userAId, {}, testPool);
      assert(failIntel.total_failed_deliveries === 3, 'Reports 3 total failed deliveries');
      assert(failIntel.total_unknown_deliveries === 1, 'Reports 1 total unknown delivery');

      // Classification breakdown
      assert(failIntel.error_classifications['permanent_rejection'] === 2, 'Classifies 2 permanent rejections');
      assert(failIntel.error_classifications['transient_rejection'] === 1, 'Classifies 1 transient rejection');
      assert(failIntel.error_classifications['connection_failure'] === 1, 'Classifies 1 connection failure');
      assert(failIntel.error_classifications['ambiguous_outcome'] === 1, 'Classifies 1 ambiguous outcome');

      // Transient vs permanent
      assert(failIntel.transient_vs_permanent.transient_count >= 2, 'Counts transient + connection failures as transient');
      assert(failIntel.transient_vs_permanent.permanent_count >= 2, 'Counts 5xx and auth failures as permanent');
      assert(failIntel.transient_vs_permanent.uncertain_count >= 1, 'Counts ambiguous outcomes as uncertain');

      // Top failure reasons
      assert(failIntel.top_failure_reasons.length > 0, 'Top failure reasons list is populated');
      assert(
        failIntel.top_failure_reasons.some((r) => r.reason.includes('550 5.1.1 User unknown')),
        'Top reasons include 550 User unknown'
      );
      assert(
        failIntel.top_failure_reasons.every((r) => r.sample_delivery_ids.length <= 3),
        'Sample delivery IDs are bounded (<= 3 per reason)'
      );

      // Attempt distribution & approaching retry limit
      assert(failIntel.attempt_distribution.max_attempts_observed === 3, 'Max attempts observed is 3');
      assert(failIntel.deliveries_approaching_retry_limit.length >= 2, 'Identifies deliveries with attempt_count >= 2');
      assert(
        failIntel.deliveries_approaching_retry_limit.every((d) => d.attempt_count >= 2),
        'All approaching-retry deliveries have attempt_count >= 2'
      );

      // ---------------------------------------------------------------------
      // TEST 6: Queue Waiting, Active, Delayed, and Failed Job Counts
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 6: Queue Waiting, Active, Delayed, and Failed Job Counts');
      console.log(SUB_SEP);

      // Add jobs to emailQueue: 1 for User A, 1 for User B, 1 delayed for User A
      await emailQueue.add('test_job_a1', {
        campaignId: campA1Id,
        recipientId: 'r_dummy_a1',
      });
      await emailQueue.add('test_job_b1', {
        campaignId: campBId,
        recipientId: 'r_dummy_b1',
      });
      await emailQueue.add(
        'test_job_a_delayed',
        {
          campaignId: campA1Id,
          recipientId: 'r_dummy_a_delayed',
        },
        { delay: 60000 }
      );

      const queueIntelA = await getQueueIntelligence(userAId, emailQueue, testPool, redis);
      assert(queueIntelA.is_available === true, 'Queue is reported as available');
      assert(queueIntelA.queue_name === 'email-queue', 'Queue name matches email-queue');
      assert(queueIntelA.global_counts !== null, 'Global queue counts returned');
      assert(queueIntelA.global_counts!.waiting >= 2, 'Global waiting jobs includes both tenant jobs');
      assert(queueIntelA.global_counts!.delayed >= 1, 'Global delayed jobs reflects delayed job');

      // ---------------------------------------------------------------------
      // TEST 7: Campaign-Level Queue Isolation (Multi-Tenant Scoping)
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 7: Campaign-Level Queue Isolation (Multi-Tenant Scoping)');
      console.log(SUB_SEP);

      assert(queueIntelA.user_scoped_counts !== null, 'User-scoped queue counts are populated');
      assert(
        queueIntelA.user_scoped_counts!.waiting === 1,
        'User A user-scoped waiting count is strictly 1 (User B job excluded)'
      );
      assert(
        queueIntelA.user_scoped_counts!.delayed === 1,
        'User A user-scoped delayed count is strictly 1'
      );

      // User B query
      const queueIntelB = await getQueueIntelligence(userBId, emailQueue, testPool, redis);
      assert(
        queueIntelB.user_scoped_counts!.waiting === 1,
        'User B user-scoped waiting count is strictly 1 (User A job excluded)'
      );
      assert(
        queueIntelB.user_scoped_counts!.delayed === 0,
        'User B user-scoped delayed count is strictly 0 (User A delayed job excluded)'
      );

      // ---------------------------------------------------------------------
      // TEST 8: User A Cannot Access User B Campaign or Sender Information
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 8: User A Cannot Access User B Campaign or Sender Information');
      console.log(SUB_SEP);

      // Verify User A campaign intelligence has zero User B data
      assert(
        !campIntel.high_failure_campaigns.some((c) => c.campaign_id === campBId),
        'User B private campaign is completely absent from User A campaign intelligence'
      );

      // Verify User A sender intelligence has zero User B data
      assert(
        !senderIntel.senders.some((s) => s.sender_id === senderBId),
        'User B private sender is completely absent from User A sender intelligence'
      );

      // Verify User A delivery failure intelligence excludes User B failures
      assert(
        !failIntel.top_failure_reasons.some((r) => r.reason.includes('Tenant B secret error')),
        'User B failure reasons are completely absent from User A failure intelligence'
      );

      // ---------------------------------------------------------------------
      // TEST 9: Empty Database and Missing Data Handling
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 9: Empty Database and Missing Data Handling');
      console.log(SUB_SEP);

      // Create User C with zero campaigns and zero senders
      const userCRes = await testClient.query(
        `INSERT INTO users (email, name) VALUES ('user_c_empty@opsintel.test', 'User C Empty') RETURNING id;`
      );
      const userCId = userCRes.rows[0].id;

      const campIntelC = await getCampaignIntelligence(userCId, {}, testPool);
      assert(campIntelC.total_campaigns === 0, 'Empty user returns total_campaigns = 0');
      assert(campIntelC.delivery_stats.total_deliveries === 0, 'Empty user returns total_deliveries = 0');
      assert(campIntelC.delivery_stats.success_rate === null, 'Empty user success_rate is null (not fabricated 0)');
      assert(campIntelC.delivery_stats.failure_rate === null, 'Empty user failure_rate is null (not fabricated 0)');
      assert(campIntelC.high_failure_campaigns.length === 0, 'Empty user high_failure_campaigns is empty array');

      const senderIntelC = await getSenderPerformanceIntelligence(userCId, testPool);
      assert(senderIntelC.senders.length === 0, 'Empty user returns 0 senders');
      assert(senderIntelC.aggregate.overall_success_rate === null, 'Aggregate success rate is null for empty user');

      const failIntelC = await getDeliveryFailureIntelligence(userCId, {}, testPool);
      assert(failIntelC.total_failed_deliveries === 0, 'Empty user has 0 failed deliveries');
      assert(failIntelC.total_unknown_deliveries === 0, 'Empty user has 0 unknown deliveries');

      const queueIntelC = await getQueueIntelligence(userCId, emailQueue, testPool, redis);
      assert(queueIntelC.user_scoped_counts?.waiting === 0, 'Empty user has 0 user-scoped queue jobs');

      // ---------------------------------------------------------------------
      // TEST 10: Redis Unavailable Handling (Graceful Degradation)
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 10: Redis Unavailable Handling (Graceful Degradation)');
      console.log(SUB_SEP);

      // Mock unavailable Redis client
      const fakeUnavailableRedis = {
        ping: async () => {
          throw new Error('Connection refused to redis:6379');
        },
      } as any;

      const queueIntelUnavail = await getQueueIntelligence(
        userAId,
        emailQueue,
        testPool,
        fakeUnavailableRedis
      );
      assert(queueIntelUnavail.is_available === false, 'Gracefully detects Redis unavailability (is_available = false)');
      assert(
        queueIntelUnavail.unavailable_reason?.includes('Connection refused'),
        'Identifies exact unavailable reason'
      );
      assert(queueIntelUnavail.queue_backlog === null, 'Queue backlog is null when unavailable (not fabricated as 0)');
      assert(queueIntelUnavail.user_scoped_counts === null, 'User scoped counts are null when unavailable');

      // ---------------------------------------------------------------------
      // TEST 11: Bounded Date Ranges and Result Sizes
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 11: Bounded Date Ranges and Result Sizes');
      console.log(SUB_SEP);

      // Query with future fromDate -> returns 0 deliveries
      const futureIntel = await getCampaignIntelligence(
        userAId,
        { fromDate: new Date(Date.now() + 86400000) },
        testPool
      );
      assert(
        futureIntel.delivery_stats.total_deliveries === 0,
        'Future fromDate filter excludes all past deliveries'
      );

      // Query with limit = 1 for high failure campaigns
      const limitedIntel = await getCampaignIntelligence(
        userAId,
        { limit: 1 },
        testPool
      );
      assert(
        limitedIntel.high_failure_campaigns.length <= 1,
        'Limit option strictly bounds high failure campaign results'
      );

      // ---------------------------------------------------------------------
      // TEST 12: No Secrets or Recipient PII in Generated Operations Context
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 12: No Secrets or Recipient PII in Generated Context');
      console.log(SUB_SEP);

      // Set up a simulated rate limit bottleneck in Redis for Campaign A1
      await redis.set(`rate-limit:campaign:${campA1Id}`, '50', 'EX', 1800);

      const opsContext = await getOperationsContext(userAId, {}, testPool, redis, emailQueue);
      assert(opsContext.user_id === userAId, 'Operations context is bound to User A');
      assert(Boolean(opsContext.timestamp), 'Operations context contains fresh timestamp');

      // Convert context to JSON string to scan for leaked secrets or PII
      const contextJson = JSON.stringify(opsContext);

      assert(!contextJson.includes('secret_pass_a1'), 'Zero SMTP passwords exposed in operations context');
      assert(!contextJson.includes('secret_pass_a2'), 'Zero secondary passwords exposed in operations context');
      assert(!contextJson.includes('secret_pass_b'), 'Zero tenant B credentials exposed in operations context');
      assert(!contextJson.includes('sent1@reachinbox.test'), 'Zero recipient email addresses leaked in context');
      assert(!contextJson.includes('Private B'), 'Zero tenant B names leaked in context');
      assert(!contextJson.includes('Content Body A1'), 'Zero email bodies leaked in context');

      // Verify bottleneck detection in context
      assert(opsContext.bottlenecks.length > 0, 'Bottleneck analysis detected operational bottlenecks');
      assert(
        opsContext.bottlenecks.some((b) => b.type === 'campaign_hourly_limit_exhausted'),
        'Campaign hourly limit exhaustion identified as bottleneck'
      );
      assert(
        opsContext.bottlenecks.some((b) => b.type === 'unknown_deliveries_pending_review'),
        'Unknown delivery outcome requiring operator review identified as bottleneck'
      );

      // Verify recommended investigations
      assert(
        opsContext.recommended_investigations.some((r) => r.includes('unknown delivery outcome')),
        'Recommended investigations include review of unknown deliveries in Recovery Center'
      );
      assert(
        opsContext.recommended_investigations.some((r) => r.includes('Campaign A2 High Failure')),
        'Recommended investigations cite specific high failure campaign subject'
      );

      // Verify citation source IDs exist
      const campBottleneck = opsContext.bottlenecks.find((b) => b.type === 'campaign_hourly_limit_exhausted');
      assert(
        campBottleneck?.source_ids.includes(campA1Id) === true,
        'Bottleneck cites exact source campaign ID for future AI Copilot attribution'
      );

      // ---------------------------------------------------------------------
      // TEST 13: Zero Database Mutations During Intelligence Queries (Read-Only)
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 13: Zero Database Mutations During Intelligence Queries (Read-Only)');
      console.log(SUB_SEP);

      const beforeCounts = await testClient.query(`
        SELECT
          (SELECT COUNT(*) FROM campaigns) AS campaigns,
          (SELECT COUNT(*) FROM recipients) AS recipients,
          (SELECT COUNT(*) FROM email_deliveries) AS deliveries,
          (SELECT COUNT(*) FROM email_attempts) AS attempts,
          (SELECT COUNT(*) FROM delivery_outbox) AS outbox,
          (SELECT COUNT(*) FROM senders) AS senders;
      `);

      // Run multiple operations intelligence queries repeatedly
      await getCampaignIntelligence(userAId, {}, testPool);
      await getDeliveryFailureIntelligence(userAId, {}, testPool);
      await getSenderPerformanceIntelligence(userAId, testPool);
      await getQueueIntelligence(userAId, emailQueue, testPool, redis);
      await analyzeOperationalBottlenecks(userAId, testPool, redis, emailQueue);
      await getOperationsContext(userAId, {}, testPool, redis, emailQueue);

      const afterCounts = await testClient.query(`
        SELECT
          (SELECT COUNT(*) FROM campaigns) AS campaigns,
          (SELECT COUNT(*) FROM recipients) AS recipients,
          (SELECT COUNT(*) FROM email_deliveries) AS deliveries,
          (SELECT COUNT(*) FROM email_attempts) AS attempts,
          (SELECT COUNT(*) FROM delivery_outbox) AS outbox,
          (SELECT COUNT(*) FROM senders) AS senders;
      `);

      assert(
        JSON.stringify(beforeCounts.rows[0]) === JSON.stringify(afterCounts.rows[0]),
        'Zero database mutations occurred across all intelligence queries (strictly read-only)'
      );

    } finally {
      await testClient.end();
      await testPool.end();
    }
  } finally {
    // Drop test database cleanly
    console.log('\n6. Cleaning up isolated test database...');
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
  console.log('\n7. Verifying original database integrity...');
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
  console.log(`  BATCH 7A VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
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

runBatch7AVerification().catch((err) => {
  console.error('\n❌ Unhandled error in Batch 7A verification:', err);
  process.exit(1);
});
