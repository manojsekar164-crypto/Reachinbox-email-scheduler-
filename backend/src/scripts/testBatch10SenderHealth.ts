/**
 * src/scripts/testBatch10SenderHealth.ts
 *
 * Isolated verification suite for Batch 10 – Sender Health Monitor & Live Diagnostics.
 * Implements Stage 8 of the ReachInbox 13-stage official development roadmap.
 *
 * SAFETY GUARANTEES:
 *  - Creates a uniquely named temporary PostgreSQL database for this run.
 *  - Restores the pre-stage1 local baseline backup into that temporary DB,
 *    then applies migrations 004–008 to validate the legacy-data upgrade path.
 *  - Never runs migrations or test queries against the production application database.
 *  - Uses a uniquely named BullMQ queue and Redis prefix for this run.
 *  - Never obliterates the application's email-queue and never deletes shared
 *    Redis rate-limit or send-spacing keys.
 *  - Drops only the temporary database created by this process.
 *
 * Test Scenarios:
 *  1. Cross-Tenant Isolation (User A cannot view health or probe User B's sender).
 *  2. Baseline Diagnostics for New Unutilized Sender (Score 100, healthy status).
 *  3. Healthy Sender Metric Aggregation & Classification (>90% acceptance).
 *  4. Degraded Sender Classification (Sub-optimal acceptance 70-85%).
 *  5. Quarantined Sender Classification (High bounce rate >= 30%).
 *  6. Quota-Based Health Classification (89% healthy, 90% degraded, 100% degraded, quarantined preservation).
 *  7. Redis Failure Graceful Fallback (resilient against cache failure, defaults to usage 0).
 *  8. Live SMTP Connection Probe Success (reachable, authenticated, latency ms, tls_active).
 *  9. Live SMTP Connection Probe Authentication Failure (EAUTH, host reachable, credential redaction).
 * 10. Live SMTP Connection Probe Network/DNS Failure (EDNS, unreachable).
 * 11. Live SMTP Connection Probe TLS Certificate Failure (ETLS, certificate validation, tls_active false).
 * 12. Live SMTP Connection Probe STARTTLS Protocol Failure (ESTARTTLS, negotiation failure).
 * 13. Insecure Plaintext Connection Rejection (EINSECURE, credentials refused over unencrypted connection).
 * 14. Multi-Sender Aggregate Health Summary & Overall Reputation Score.
 * 15. Strict Credential Protection Invariant (smtp_pass never exposed in health or probe output).
 */

process.env.START_WORKER = 'false';
process.env.SEND_DELAY_TEST_MS = '0';
process.env.DISABLE_ES_INDEXING = 'true';

import { Client, Pool, PoolClient } from 'pg';
import { execFileSync } from 'child_process';
import { Queue } from 'bullmq';
import nodemailer from 'nodemailer';
import type { EmailJobPayload } from '../queue/emailQueue';
import { config } from '../config';
import { runMigrations } from '../db/migrate';
import {
  emailQueue as defaultEmailQueue,
  emailQueueName,
  redisConnectionOptions,
} from '../queue/emailQueue';
import {
  getSenderHealth,
  listAllSendersHealth,
  probeSenderConnectivity,
} from '../services/senderHealthService';
import { createSender } from '../services/senderService';

const SEP = '='.repeat(74);
const SUB_SEP = '-'.repeat(74);

const RUN_ID = `${process.pid}_${Date.now()}`;
const TEST_DB_NAME = `reachinbox_b10_test_${RUN_ID}`;
const TEST_QUEUE_NAME = `${emailQueueName}-b10-${RUN_ID}`;
const TEST_QUEUE_PREFIX = `reachinbox-b10-test-${RUN_ID}`;
const BACKUP_CONTAINER = process.env.BATCH10_BACKUP_CONTAINER || 'reachinbox_postgres';
const BACKUP_PATH = process.env.BATCH10_LEGACY_BACKUP_PATH || '/tmp/reachinbox-pre-stage1.dump';

const appDatabaseUrl = new URL(config.db.url);
const resolvedPgHost = process.env.PGHOST || appDatabaseUrl.hostname;

if (config.app.isProd) {
  throw new Error('Batch 10 verification is disabled when NODE_ENV=production.');
}

const BASE_PG_CONFIG = {
  host: resolvedPgHost,
  port: Number(process.env.PGPORT || appDatabaseUrl.port || 5432),
  user: process.env.PGUSER || decodeURIComponent(appDatabaseUrl.username),
  password: process.env.PGPASSWORD || decodeURIComponent(appDatabaseUrl.password),
  ...(appDatabaseUrl.searchParams.get('sslmode') === 'require'
    ? { ssl: { rejectUnauthorized: false } }
    : {}),
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

async function runBatch10Verification(): Promise<void> {
  console.log('\n' + SEP);
  console.log('  BATCH 10 VERIFICATION: SENDER HEALTH MONITOR & LIVE DIAGNOSTICS');
  console.log(`  PostgreSQL server: ${BASE_PG_CONFIG.host}:${BASE_PG_CONFIG.port}`);
  console.log('  Test database:     ' + TEST_DB_NAME);
  console.log('  Test queue:        ' + TEST_QUEUE_NAME);
  console.log('  Application DB:    not used as a migration/restore target');
  console.log(SEP + '\n');

  const adminClient = new Client({
    ...BASE_PG_CONFIG,
    database: 'postgres',
  });
  let databaseCreated = false;
  let testClientForCleanup: PoolClient | undefined;
  let testPoolForCleanup: Pool | undefined;
  let testQueueForCleanup: Queue<EmailJobPayload> | undefined;

  try {
    await adminClient.connect();

    // 1. Create isolated ephemeral test database
    console.log('1. Creating a uniquely named isolated test database...');
    await adminClient.query(`CREATE DATABASE "${TEST_DB_NAME}";`);
    databaseCreated = true;
    console.log(`   Database "${TEST_DB_NAME}" created.\n`);

    // 2. Restore baseline snapshot into isolated DB
    console.log('2. Restoring the pre-stage1 baseline snapshot into the isolated database...');
    execFileSync('docker', [
      'exec',
      BACKUP_CONTAINER,
      'pg_restore',
      '-U',
      'postgres',
      '-d',
      TEST_DB_NAME,
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      BACKUP_PATH,
    ]);
    console.log('   Baseline snapshot restored into the temporary database.\n');

    // 3. Connect test pool and client to isolated database
    const testPool = new Pool({
      ...BASE_PG_CONFIG,
      database: TEST_DB_NAME,
      max: 10,
    });
    testPoolForCleanup = testPool;
    const testClient = await testPool.connect();
    testClientForCleanup = testClient;

    // Apply schema migrations
    console.log('3. Applying repository migrations to the isolated database...');
    const migrationResult = await runMigrations(testClient);
    console.log(`   Migrations applied: ${migrationResult.applied.length}, skipped: ${migrationResult.skipped.length}`);
    assert(
      migrationResult.applied.length >= 5,
      'Schema migrations applied successfully on isolated test database'
    );

    // Setup isolated test queue
    const testQueue = new Queue<EmailJobPayload>(TEST_QUEUE_NAME, {
      connection: redisConnectionOptions,
      prefix: TEST_QUEUE_PREFIX,
    });
    testQueueForCleanup = testQueue;
    await testQueue.waitUntilReady();

    // Mock Redis client for rate limit checks
    const mockRedisMap = new Map<string, string>();
    const mockRedis = {
      get: async (key: string) => mockRedisMap.get(key) || null,
      set: async (key: string, val: string) => { mockRedisMap.set(key, String(val)); return 'OK'; },
    };

    // 5. Seed test users
    console.log('\n4. Seeding multi-tenant test fixtures in isolated database...');
    const userARes = await testClient.query(
      `INSERT INTO users (name, email) VALUES ('User A (Sender Health)', 'user_a_sh@reachinbox.test') RETURNING id;`
    );
    const userAId = userARes.rows[0].id;

    const userBRes = await testClient.query(
      `INSERT INTO users (name, email) VALUES ('User B (Sender Health)', 'user_b_sh@reachinbox.test') RETURNING id;`
    );
    const userBId = userBRes.rows[0].id;

    // Create senders for User A and User B
    const senderARes = await testClient.query(
      `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, hourly_limit)
       VALUES ($1, 'User A Primary', 'sender_a@reachinbox.test', 'smtp.ethereal.email', 587, false, 'user_a_smtp', 'enc_pass_a', 100)
       RETURNING id;`,
      [userAId]
    );
    const senderAId = senderARes.rows[0].id;

    const senderBRes = await testClient.query(
      `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, hourly_limit)
       VALUES ($1, 'User B Foreign', 'sender_b@reachinbox.test', 'smtp.ethereal.email', 587, false, 'user_b_smtp', 'enc_pass_b', 100)
       RETURNING id;`,
      [userBId]
    );
    const senderBId = senderBRes.rows[0].id;

    // Helper to create campaign, recipient, delivery and attempt
    async function recordDeliveryAttempt(
      campaignId: string,
      senderId: string,
      recipientEmail: string,
      deliveryStatus: string,
      attemptStatus: string,
      errorClassification: string | null = null,
      smtpCode: string | null = null
    ) {
      const recRes = await testClient.query(
        `INSERT INTO recipients (campaign_id, email, name, status) VALUES ($1, $2, 'Recipient', 'pending') RETURNING id;`,
        [campaignId, recipientEmail]
      );
      const recipientId = recRes.rows[0].id;

      const delRes = await testClient.query(
        `INSERT INTO email_deliveries (
           campaign_id, recipient_id, sender_id, idempotency_key, status, sent_at, last_error
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id;`,
        [
          campaignId,
          recipientId,
          senderId,
          `key_${Date.now()}_${Math.random()}`,
          deliveryStatus,
          deliveryStatus === 'sent' ? new Date() : null,
          errorClassification ? `Error: ${errorClassification}` : null,
        ]
      );
      const deliveryId = delRes.rows[0].id;

      await testClient.query(
        `INSERT INTO email_attempts (
           delivery_id, attempt_number, status, sender_id, smtp_response_code, error_classification, error_message, attempted_at, completed_at
         )
         VALUES ($1, 1, $2, $3, $4, $5, $6, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '9 minutes');`,
        [
          deliveryId,
          attemptStatus,
          senderId,
          smtpCode,
          errorClassification,
          errorClassification ? `Simulated error: ${errorClassification}` : null,
        ]
      );

      return { deliveryId, recipientId };
    }

    // ---------------------------------------------------------------------
    // TEST 1: Cross-Tenant Isolation
    // ---------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 1: Cross-Tenant Isolation');
    console.log(SUB_SEP);

    // User A cannot view health of User B sender
    let userBAccessBlocked = false;
    try {
      await getSenderHealth(senderBId, userAId, testPool, mockRedis);
    } catch (err: any) {
      if (err.statusCode === 404 || err.message.includes('access denied')) {
        userBAccessBlocked = true;
      }
    }
    assert(userBAccessBlocked, 'User A cannot access User B sender health (404 Access Denied)');

    // User A cannot probe User B sender
    let userBProbeBlocked = false;
    try {
      await probeSenderConnectivity(senderBId, userAId, testPool);
    } catch (err: any) {
      if (err.statusCode === 404 || err.message.includes('access denied')) {
        userBProbeBlocked = true;
      }
    }
    assert(userBProbeBlocked, 'User A cannot probe User B sender connectivity (404 Access Denied)');

    // listAllSendersHealth returns strictly User A senders
    const allSendersA = await listAllSendersHealth(userAId, testPool, mockRedis);
    assert(allSendersA.total_senders === 1, 'User A listing contains exactly User A senders');
    assert(allSendersA.senders[0].sender_id === senderAId, 'Listing matches User A sender ID');
    assert(!allSendersA.senders.some((s) => s.sender_id === senderBId), 'User B sender completely excluded from User A listing');

    // ---------------------------------------------------------------------
    // TEST 2: Baseline Diagnostics for New Unutilized Sender
    // ---------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 2: Baseline Diagnostics for New Unutilized Sender');
    console.log(SUB_SEP);

    const newSenderHealth = await getSenderHealth(senderAId, userAId, testPool, mockRedis);
    assert(newSenderHealth.unique_deliveries === 0, 'Unique deliveries is 0 for new sender');
    assert(newSenderHealth.total_attempts === 0, 'Total attempts is 0 for new sender');
    assert(newSenderHealth.reputation_score === 100, 'Baseline reputation score is 100');
    assert(newSenderHealth.health_status === 'healthy', 'New sender defaults to "healthy"');
    assert(newSenderHealth.acceptance_rate === 100.0, 'Default acceptance rate is 100%');
    assert(newSenderHealth.quota_remaining === 100, 'Full hourly quota remains (100)');

    // ---------------------------------------------------------------------
    // TEST 3: Healthy Sender Metric Aggregation & Classification
    // ---------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 3: Healthy Sender Metric Aggregation & Classification');
    console.log(SUB_SEP);

    const campARes = await testClient.query(
      `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
       VALUES ($1, $2, 'Healthy Campaign', 'Body', 'sending', 100) RETURNING id;`,
      [userAId, senderAId]
    );
    const campAId = campARes.rows[0].id;

    // Record 10 successful dispatches for Sender A
    for (let i = 1; i <= 10; i++) {
      await recordDeliveryAttempt(
        campAId,
        senderAId,
        `healthy_${i}@reachinbox.test`,
        'sent',
        'sent',
        null,
        '250 2.0.0 OK'
      );
    }

    const healthyHealth = await getSenderHealth(senderAId, userAId, testPool, mockRedis);
    assert(healthyHealth.unique_deliveries === 10, 'Unique deliveries equals 10');
    assert(healthyHealth.sent_deliveries === 10, 'Sent deliveries equals 10');
    assert(healthyHealth.failed_deliveries === 0, 'Failed deliveries equals 0');
    assert(healthyHealth.bounce_rate === 0.0, 'Bounce rate is 0.0%');
    assert(healthyHealth.acceptance_rate === 100.0, 'Acceptance rate is 100.0%');
    assert(healthyHealth.reputation_score === 100, 'Reputation score is 100/100');
    assert(healthyHealth.health_status === 'healthy', 'Health status classified as "healthy"');

    // ---------------------------------------------------------------------
    // TEST 4: Degraded Sender Classification (Sub-Optimal Acceptance)
    // ---------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 4: Degraded Sender Classification (Sub-Optimal Acceptance)');
    console.log(SUB_SEP);

    const senderDegradedRes = await testClient.query(
      `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, hourly_limit)
       VALUES ($1, 'User A Degraded', 'degraded@reachinbox.test', 'smtp.ethereal.email', 587, false, 'user_a_deg', 'enc_pass', 100)
       RETURNING id;`,
      [userAId]
    );
    const senderDegradedId = senderDegradedRes.rows[0].id;

    const campDegRes = await testClient.query(
      `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
       VALUES ($1, $2, 'Degraded Campaign', 'Body', 'sending', 100) RETURNING id;`,
      [userAId, senderDegradedId]
    );
    const campDegId = campDegRes.rows[0].id;

    // 7 successful + 3 transient failures (70% acceptance rate)
    for (let i = 1; i <= 7; i++) {
      await recordDeliveryAttempt(
        campDegId,
        senderDegradedId,
        `deg_sent_${i}@reachinbox.test`,
        'sent',
        'sent',
        null,
        '250 2.0.0 OK'
      );
    }
    for (let i = 1; i <= 3; i++) {
      await recordDeliveryAttempt(
        campDegId,
        senderDegradedId,
        `deg_fail_${i}@reachinbox.test`,
        'failed',
        'failed',
        'transient_failure',
        '451 4.7.1 Try again'
      );
    }

    const degradedHealth = await getSenderHealth(senderDegradedId, userAId, testPool, mockRedis);
    assert(degradedHealth.unique_deliveries === 10, 'Unique deliveries equals 10');
    assert(degradedHealth.sent_deliveries === 7, 'Sent deliveries equals 7');
    assert(degradedHealth.failed_deliveries === 3, 'Failed deliveries equals 3');
    assert(degradedHealth.acceptance_rate === 70.0, 'Acceptance rate is 70.0%');
    assert(degradedHealth.health_status === 'degraded', 'Health status classified as "degraded" (acceptance < 85%)');
    assert(degradedHealth.health_reasons.some((r) => r.includes('Sub-optimal SMTP acceptance rate')), 'Degraded reason explicitly cites sub-optimal acceptance rate');

    // ---------------------------------------------------------------------
    // TEST 5: Quarantined Sender Classification (High Bounce Rate)
    // ---------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 5: Quarantined Sender Classification (High Bounce Rate)');
    console.log(SUB_SEP);

    const senderQuarantineRes = await testClient.query(
      `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, hourly_limit)
       VALUES ($1, 'User A Quarantined', 'quarantine@reachinbox.test', 'smtp.ethereal.email', 587, false, 'user_a_quar', 'enc_pass', 100)
       RETURNING id;`,
      [userAId]
    );
    const senderQuarantineId = senderQuarantineRes.rows[0].id;

    const campQuarRes = await testClient.query(
      `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
       VALUES ($1, $2, 'Quarantine Campaign', 'Body', 'sending', 100) RETURNING id;`,
      [userAId, senderQuarantineId]
    );
    const campQuarId = campQuarRes.rows[0].id;

    // 6 sent + 4 hard bounces (40% bounce rate >= 30% threshold)
    for (let i = 1; i <= 6; i++) {
      await recordDeliveryAttempt(
        campQuarId,
        senderQuarantineId,
        `quar_sent_${i}@reachinbox.test`,
        'sent',
        'sent',
        null,
        '250 2.0.0 OK'
      );
    }
    for (let i = 1; i <= 4; i++) {
      await recordDeliveryAttempt(
        campQuarId,
        senderQuarantineId,
        `quar_bounce_${i}@reachinbox.test`,
        'failed',
        'failed',
        'mailbox_not_found',
        '550 5.1.1 User unknown'
      );
    }

    const quarantinedHealth = await getSenderHealth(senderQuarantineId, userAId, testPool, mockRedis);
    assert(quarantinedHealth.bounce_rate === 40.0, 'Bounce rate is 40.0%');
    assert(quarantinedHealth.health_status === 'quarantined', 'Health status classified as "quarantined"');
    assert(quarantinedHealth.reputation_score <= 50, 'Reputation score is critically degraded (<= 50)');
    assert(quarantinedHealth.health_reasons.some((r) => r.includes('Critical failure rate') && r.includes('paused to protect domain reputation')), 'Quarantine reason warns to pause dispatches');

    // ---------------------------------------------------------------------
    // TEST 6: Quota-Based Health Classification (89%, 90%, 100%, and Quarantined Preservation)
    // ---------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 6: Quota-Based Health Classification (89%, 90%, 100%, and Quarantined Preservation)');
    console.log(SUB_SEP);

    // 6a. 89% quota usage: Below 90% threshold -> remains healthy, no quota warning
    await mockRedis.set(`rate-limit:sender:${senderAId}`, '89');
    const quota89 = await getSenderHealth(senderAId, userAId, testPool, mockRedis);
    assert(quota89.hourly_usage === 89, 'Accurately reads hourly usage 89 from Redis');
    assert(quota89.quota_remaining === 11, 'Accurately reports quota remaining = 11');
    assert(quota89.health_status === 'healthy', '89% usage does not trigger quota degradation (remains healthy)');
    assert(!quota89.health_reasons.some((r) => r.includes('Hourly send quota nearly exhausted')), 'No quota exhaustion warning emitted at 89%');

    // 6b. 90% quota usage: At threshold -> transitions healthy to degraded
    await mockRedis.set(`rate-limit:sender:${senderAId}`, '90');
    const quota90 = await getSenderHealth(senderAId, userAId, testPool, mockRedis);
    assert(quota90.hourly_usage === 90, 'Accurately reads hourly usage 90 from Redis');
    assert(quota90.quota_remaining === 10, 'Accurately reports quota remaining = 10');
    assert(quota90.health_status === 'degraded', '90% usage transitions healthy sender to degraded');
    assert(quota90.health_reasons.some((r) => r.includes('Hourly send quota nearly exhausted: 90/100 sends used (90%).')), 'Quota degradation warning emitted at 90%');

    // 6c. 100% quota usage: Fully exhausted -> degraded, 0 remaining
    await mockRedis.set(`rate-limit:sender:${senderAId}`, '100');
    const quota100 = await getSenderHealth(senderAId, userAId, testPool, mockRedis);
    assert(quota100.hourly_usage === 100, 'Accurately reads hourly usage 100 from Redis');
    assert(quota100.quota_remaining === 0, 'Accurately reports quota remaining = 0');
    assert(quota100.health_status === 'degraded', '100% usage maintains degraded status');
    assert(quota100.health_reasons.some((r) => r.includes('Hourly send quota nearly exhausted: 100/100 sends used (100%).')), 'Quota degradation warning emitted at 100%');

    // 6d. Quota saturation on quarantined sender: Must strictly remain quarantined
    await mockRedis.set(`rate-limit:sender:${senderQuarantineId}`, '95');
    const quotaQuar = await getSenderHealth(senderQuarantineId, userAId, testPool, mockRedis);
    assert(quotaQuar.hourly_usage === 95, 'Accurately reads hourly usage 95 from Redis for quarantined sender');
    assert(quotaQuar.health_status === 'quarantined', 'Quarantined sender strictly preserves quarantined status under quota saturation');
    assert(quotaQuar.health_reasons.some((r) => r.includes('Hourly send quota nearly exhausted')), 'Quota saturation reason appended alongside quarantine reasons');

    // Reset Redis usage keys
    await mockRedis.set(`rate-limit:sender:${senderAId}`, '0');
    await mockRedis.set(`rate-limit:sender:${senderQuarantineId}`, '0');

    // ---------------------------------------------------------------------
    // TEST 7: Redis Failure Graceful Fallback
    // ---------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 7: Redis Failure Graceful Fallback');
    console.log(SUB_SEP);

    const failingRedis = {
      get: async () => {
        throw new Error('Redis connection lost');
      },
      set: async () => 'OK',
    };
    const fallbackHealth = await getSenderHealth(senderAId, userAId, testPool, failingRedis);
    assert(fallbackHealth.hourly_usage === 0, 'Falls back safely to hourly_usage = 0 on Redis error');
    assert(fallbackHealth.quota_remaining === 100, 'Falls back safely to full quota remaining on Redis error');
    assert(fallbackHealth.health_status === 'healthy', 'Health check succeeds without crashing when Redis is down');

    // ---------------------------------------------------------------------
    // TEST 8: Live SMTP Connection Probe Success
    // ---------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 8: Live SMTP Connection Probe Success');
    console.log(SUB_SEP);

    // Mock successful transporter
    const mockSuccessTransporter: any = {
      verify: async () => true,
    };

    const probeSuccess = await probeSenderConnectivity(senderAId, userAId, testPool, mockSuccessTransporter);
    assert(probeSuccess.reachable === true, 'Probe reports reachable = true');
    assert(probeSuccess.authenticated === true, 'Probe reports authenticated = true');
    assert(probeSuccess.tls_active === true, 'Probe reports TLS active');
    assert(probeSuccess.latency_ms >= 0, 'Probe measures latency in milliseconds');
    assert(probeSuccess.response_message.includes('verified successfully'), 'Probe returns success message');

    // ---------------------------------------------------------------------
    // TEST 9: Live SMTP Connection Probe Authentication Failure
    // ---------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 9: Live SMTP Connection Probe Authentication Failure');
    console.log(SUB_SEP);

    // Mock auth failure transporter
    const mockAuthFailTransporter: any = {
      verify: async () => {
        const err: any = new Error('535 5.7.8 Username and Password not accepted');
        err.code = 'EAUTH';
        err.responseCode = 535;
        throw err;
      },
    };

    const probeAuthFail = await probeSenderConnectivity(senderAId, userAId, testPool, mockAuthFailTransporter);
    assert(probeAuthFail.reachable === true, 'Probe reports reachable = true on auth error (host reached, credentials rejected)');
    assert(probeAuthFail.authenticated === false, 'Probe reports authenticated = false');
    assert(probeAuthFail.tls_active === false, 'Probe reports tls_active = false on auth failure');
    assert(probeAuthFail.error_code === 'EAUTH', 'Probe reports error_code = EAUTH');
    assert(!probeAuthFail.error_message?.includes('enc_pass_a'), 'Plaintext password is never leaked in error diagnostics');

    // ---------------------------------------------------------------------
    // TEST 10: Live SMTP Connection Probe Network/DNS Failure
    // ---------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 10: Live SMTP Connection Probe Network/DNS Failure');
    console.log(SUB_SEP);

    const mockDnsFailTransporter: any = {
      verify: async () => {
        const err: any = new Error('getaddrinfo ENOTFOUND invalid.smtp.domain');
        err.code = 'EDNS';
        throw err;
      },
    };

    const probeDnsFail = await probeSenderConnectivity(senderAId, userAId, testPool, mockDnsFailTransporter);
    assert(probeDnsFail.reachable === false, 'Probe reports reachable = false on DNS failure');
    assert(probeDnsFail.authenticated === false, 'Probe reports authenticated = false');
    assert(probeDnsFail.tls_active === false, 'Probe reports tls_active = false on DNS failure');
    assert(probeDnsFail.error_code === 'EDNS', 'Probe reports error_code = EDNS');

    // ---------------------------------------------------------------------
    // TEST 11: Live SMTP Connection Probe TLS Certificate Failure (ETLS)
    // ---------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 11: Live SMTP Connection Probe TLS Certificate Failure (ETLS)');
    console.log(SUB_SEP);

    const mockTlsCertFailTransporter: any = {
      verify: async () => {
        const err: any = new Error('self signed certificate in certificate chain');
        err.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
        throw err;
      },
    };

    const probeTlsCertFail = await probeSenderConnectivity(senderAId, userAId, testPool, mockTlsCertFailTransporter);
    assert(probeTlsCertFail.reachable === true, 'Probe reports reachable = true on TLS cert error (host contacted)');
    assert(probeTlsCertFail.authenticated === false, 'Probe reports authenticated = false on TLS cert failure');
    assert(probeTlsCertFail.tls_active === false, 'Probe reports tls_active = false on invalid TLS certificate');
    assert(probeTlsCertFail.error_code === 'ETLS', 'Probe maps certificate validation failure to ETLS');
    assert(!probeTlsCertFail.error_message?.includes('enc_pass_a'), 'Plaintext password is never leaked in TLS diagnostics');

    // ---------------------------------------------------------------------
    // TEST 12: Live SMTP Connection Probe STARTTLS Failure (ESTARTTLS)
    // ---------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 12: Live SMTP Connection Probe STARTTLS Failure (ESTARTTLS)');
    console.log(SUB_SEP);

    const mockStartTlsFailTransporter: any = {
      verify: async () => {
        const err: any = new Error('STARTTLS command failed: 454 TLS not available');
        err.code = 'ESTARTTLS';
        throw err;
      },
    };

    const probeStartTlsFail = await probeSenderConnectivity(senderAId, userAId, testPool, mockStartTlsFailTransporter);
    assert(probeStartTlsFail.reachable === true, 'Probe reports reachable = true on STARTTLS failure');
    assert(probeStartTlsFail.authenticated === false, 'Probe reports authenticated = false on STARTTLS failure');
    assert(probeStartTlsFail.tls_active === false, 'Probe reports tls_active = false on STARTTLS failure');
    assert(probeStartTlsFail.error_code === 'ESTARTTLS', 'Probe maps STARTTLS protocol negotiation failure to ESTARTTLS');

    // ---------------------------------------------------------------------
    // TEST 13: Insecure Plaintext Connection Rejection (EINSECURE)
    // ---------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 13: Insecure Plaintext Connection Rejection (EINSECURE)');
    console.log(SUB_SEP);

    // Create a sender configured with port 25 without TLS
    const senderInsecureRes = await testClient.query(
      `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, hourly_limit)
       VALUES ($1, 'User A Plaintext', 'insecure@reachinbox.test', 'smtp.insecure.test', 25, false, 'insecure_user', 'enc_pass_insecure', 100)
       RETURNING id;`,
      [userAId]
    );
    const senderInsecureId = senderInsecureRes.rows[0].id;

    const probeInsecure = await probeSenderConnectivity(senderInsecureId, userAId, testPool);
    assert(probeInsecure.reachable === false, 'Insecure plaintext probe reports reachable = false');
    assert(probeInsecure.authenticated === false, 'Insecure plaintext probe reports authenticated = false');
    assert(probeInsecure.tls_active === false, 'Insecure plaintext probe reports tls_active = false');
    assert(probeInsecure.error_code === 'EINSECURE', 'Insecure plaintext probe returns error_code = EINSECURE');
    assert(probeInsecure.response_message.includes('Insecure SMTP configuration rejected'), 'Refuses plaintext credential transmission in response message');

    // Clean up temporary insecure sender so fleet summary remains exactly 3 senders
    await testClient.query(`DELETE FROM senders WHERE id = $1;`, [senderInsecureId]);

    // ---------------------------------------------------------------------
    // TEST 14: Multi-Sender Aggregate Health Summary & Overall Reputation
    // ---------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 14: Multi-Sender Aggregate Health Summary & Overall Reputation');
    console.log(SUB_SEP);

    const summaryA = await listAllSendersHealth(userAId, testPool, mockRedis);
    assert(summaryA.total_senders === 3, 'User A has 3 configured senders (healthy, degraded, quarantined)');
    assert(summaryA.healthy_count === 1, 'Exactly 1 healthy sender reported');
    assert(summaryA.degraded_count === 1, 'Exactly 1 degraded sender reported');
    assert(summaryA.quarantined_count === 1, 'Exactly 1 quarantined sender reported');
    assert(summaryA.overall_reputation_score > 0 && summaryA.overall_reputation_score < 100, 'Overall reputation score accurately calculated across fleet');

    // ---------------------------------------------------------------------
    // TEST 15: Strict Credential Protection Invariant
    // ---------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 15: Strict Credential Protection Invariant');
    console.log(SUB_SEP);

    // Verify health metrics JSON does not contain smtp_pass
    const healthJson = JSON.stringify(summaryA);
    assert(!healthJson.includes('smtp_pass'), 'Health summary JSON never exposes "smtp_pass" key');
    assert(!healthJson.includes('enc_pass_a'), 'Health summary JSON never exposes stored password string');

    const probeJson = JSON.stringify(probeSuccess);
    assert(!probeJson.includes('smtp_pass'), 'Probe result JSON never exposes "smtp_pass" key');

  } finally {
    console.log('\n5. Cleaning up Batch 10 test resources...');

    if (testQueueForCleanup) {
      try {
        await testQueueForCleanup.obliterate({ force: true });
      } catch (cleanupError: any) {
        console.warn(`   Test queue cleanup warning: ${cleanupError.message}`);
        failed++;
      }
      try {
        await testQueueForCleanup.close();
      } catch (_) {}
    }

    if (testClientForCleanup) {
      try { testClientForCleanup.release(); } catch (_) {}
    }
    if (testPoolForCleanup) {
      try { await testPoolForCleanup.end(); } catch (_) {}
    }

    if (databaseCreated) {
      try {
        await adminClient.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid();`,
          [TEST_DB_NAME]
        );
        await adminClient.query(`DROP DATABASE "${TEST_DB_NAME}";`);
        console.log(`   Temporary database "${TEST_DB_NAME}" dropped.`);
      } catch (cleanupError: any) {
        console.error(`   Could not drop temporary test database: ${cleanupError.message}`);
        failed++;
      }
    }

    try { await defaultEmailQueue.close(); } catch (_) {}
    try { await adminClient.end(); } catch (_) {}
  }

  console.log('   No application queue keys or shared Redis rate-limit/spacing keys were deleted.');

  console.log('\n' + SEP);
  console.log(`  BATCH 10 VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log(SEP + '\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runBatch10Verification().catch((err) => {
  console.error('\n❌ Unhandled error in Batch 10 verification:', err);
  process.exit(1);
});
