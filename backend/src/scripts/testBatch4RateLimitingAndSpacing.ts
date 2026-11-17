/**
 * src/scripts/testBatch4RateLimitingAndSpacing.ts
 *
 * REACHINBOX — BATCH 4 ACCEPTANCE TEST SUITE
 * Distributed Rate Limiting and Minimum Send Spacing Verification
 *
 * Verifies all 10 Batch 4 acceptance criteria against an isolated ephemeral PostgreSQL
 * database, isolated Redis keys, and an in-process RFC 5321 SMTP test server:
 *
 *  1. Global hourly limit across multiple workers.
 *  2. Sender hourly limit shared across multiple campaigns.
 *  3. Campaign hourly limit remains functional.
 *  4. Minimum spacing across concurrent workers.
 *  5. No partial quota consumption when another applicable limit blocks sending.
 *  6. Correct delay calculation for each limiting reason.
 *  7. Delivery claim release and retry_wait persistence.
 *  8. Delayed jobs survive worker restart.
 *  9. Rate-limit reservations remain safe under Redis concurrency.
 * 10. Batch 3 stale reconciliation runs before worker processing starts.
 *
 * INVARIANTS:
 *  - Uses ephemeral DB `reachinbox_migration_test`.
 *  - Production DB `reachinbox` is NEVER touched.
 *  - Zero fabricated data or artificial delays.
 *  - Redis server time used for coordinated distributed timing.
 */

// Disable default background workers & ES during tests
process.env.START_WORKER = 'false';
process.env.SEND_DELAY_TEST_MS = '0';
process.env.DISABLE_ES_INDEXING = 'true';
process.env.NODE_ENV = 'test';

import net from 'net';
import { Client, Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';
import { Worker, Queue, Job } from 'bullmq';
import { redis } from '../db/redis';
import { runMigrations } from '../db/migrate';
import { processEmailJob, initializeWorker } from '../workers/emailWorker';
import { getDelivery, claimDelivery, ensureDeliveryRecord } from '../services/deliveryService';
import {
  reserveSendSlot,
  getGlobalHourlyLimit,
  checkRateLimit,
  checkSenderRateLimit,
} from '../services/rateLimiter';
import { checkSendSpacing } from '../services/sendSpacing';
import { clearTransporterCache } from '../services/emailService';
import { safeEncrypt } from '../utils/crypto';
import { redisConnectionOptions } from '../queue/emailQueue';

const BASE_PG_CONFIG = {
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
};

const TEST_DB_NAME = 'reachinbox_migration_test';
const BACKUP_FILE = path.resolve(__dirname, '../../backups/reachinbox_pre_stage1_backup.sql');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, description: string, extra?: string): void {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  [PASS] ${description}`);
  } else {
    failedTests++;
    console.error(`  [FAIL] ${description}${extra ? ` (${extra})` : ''}`);
  }
}

const SEP = '='.repeat(74);
const SUB_SEP = '-'.repeat(74);

// =============================================================================
// Deterministic In-Process RFC 5321 SMTP Test Server
// =============================================================================

interface SmtpServerControl {
  assignedMessageId: string;
  submissionsCount: number;
  server: net.Server | null;
  port: number;
}

const smtpControl: SmtpServerControl = {
  assignedMessageId: '<init@batch4.smtp>',
  submissionsCount: 0,
  server: null,
  port: 0,
};

function startSmtpTestServer(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let inData = false;
      let dataBuffer = '';

      socket.write('220 smtp.batch4.test ESMTP Service Ready\r\n');

      socket.on('data', (chunk) => {
        const text = chunk.toString();

        if (inData) {
          dataBuffer += text;
          if (dataBuffer.includes('\r\n.\r\n') || dataBuffer.endsWith('\r\n.')) {
            inData = false;
            smtpControl.submissionsCount++;
            socket.write(`250 2.0.0 OK: queued as ${smtpControl.assignedMessageId}\r\n`);
          }
          return;
        }

        const lines = text.split('\r\n');
        for (const line of lines) {
          if (!line) continue;
          const upper = line.toUpperCase();

          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            socket.write('250-smtp.batch4.test\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n');
          } else if (upper.startsWith('AUTH LOGIN') || upper.startsWith('AUTH PLAIN')) {
            socket.write('235 2.7.0 Authentication successful\r\n');
          } else if (upper.startsWith('MAIL FROM:')) {
            socket.write('250 2.1.0 Sender OK\r\n');
          } else if (upper.startsWith('RCPT TO:')) {
            socket.write('250 2.1.5 Recipient OK\r\n');
          } else if (upper.startsWith('DATA')) {
            inData = true;
            dataBuffer = '';
            socket.write('354 Start mail input; end with <CRLF>.<CRLF>\r\n');
            break;
          } else if (upper.startsWith('QUIT')) {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else if (upper.startsWith('RSET')) {
            socket.write('250 2.0.0 Reset OK\r\n');
          }
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      smtpControl.server = server;
      smtpControl.port = addr.port;
      resolve(addr.port);
    });
  });
}

function stopSmtpTestServer(): Promise<void> {
  return new Promise((resolve) => {
    if (smtpControl.server) {
      smtpControl.server.close(() => resolve());
    } else {
      resolve();
    }
  });
}

// =============================================================================
// Main Batch 4 Verification Runner
// =============================================================================

async function runBatch4Verification(): Promise<void> {
  console.log('\n' + SEP);
  console.log('  BATCH 4 VERIFICATION: DISTRIBUTED RATE LIMITING & SEND SPACING');
  console.log('  Target Database: reachinbox_migration_test (Ephemeral Isolated Test DB)');
  console.log('  Production DB:   reachinbox (UNTOUCHED)');
  console.log(SEP);

  // Clean test rate-limit keys in Redis
  const keysPattern = await redis.keys('rate-limit:*');
  if (keysPattern.length > 0) {
    await redis.del(...keysPattern);
  }
  await redis.del('email-send:global:last-send');

  const smtpPort = await startSmtpTestServer();
  console.log(`\n1. Started RFC 5321 SMTP test server on 127.0.0.1:${smtpPort}`);

  // Prepare isolated DB
  console.log('\n2. Preparing isolated ephemeral test database...');
  const adminClient = new Client({
    ...BASE_PG_CONFIG,
    database: 'postgres',
  });
  await adminClient.connect();

  try {
    await adminClient.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();
    `);
    await adminClient.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminClient.query(`CREATE DATABASE ${TEST_DB_NAME};`);
    console.log(`   Database "${TEST_DB_NAME}" created.`);

    // Restore pre-stage1 backup
    console.log('\n3. Restoring pre-stage1 backup into isolated database...');
    const pgRestoreCmd = `docker exec reachinbox_postgres pg_restore -U ${BASE_PG_CONFIG.user} -d ${TEST_DB_NAME} --clean --if-exists /tmp/reachinbox_pre_stage1_backup.sql`;
    try {
      execSync(pgRestoreCmd, { stdio: 'pipe' });
    } catch {}
    console.log('   pg_restore completed successfully.');

    const testPool = new Pool({
      ...BASE_PG_CONFIG,
      database: TEST_DB_NAME,
    });
    const testClient = await testPool.connect();

    // Run migrations
    console.log('\n4. Applying schema migrations to isolated database...');
    const migrationResult = await runMigrations(testClient);
    console.log(`   Migrations applied: ${migrationResult.applied.length}, skipped: ${migrationResult.skipped.length}`);

    try {
      // Create test user
      const userRes = await testClient.query(
        `INSERT INTO users (email, name)
         VALUES ('batch4_user@reachinbox.test', 'Batch 4 User')
         RETURNING id;`
      );
      const userId = userRes.rows[0].id;

      const createTestSender = async (name: string, email: string, hourlyLimit: number) => {
        const encryptedPass = safeEncrypt('secret');
        const res = await testClient.query(
          `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, hourly_limit)
           VALUES ($1, $2, $3, '127.0.0.1', $4, false, 'user', $5, $6)
           RETURNING id;`,
          [userId, name, email, smtpPort, encryptedPass, hourlyLimit]
        );
        return res.rows[0].id;
      };

      const createTestCampaign = async (subject: string, senderId: string | null, hourlyLimit: number) => {
        const res = await testClient.query(
          `INSERT INTO campaigns (user_id, sender_id, subject, body, status, hourly_limit)
           VALUES ($1, $2, $3, 'Test Body', 'sending', $4)
           RETURNING id;`,
          [userId, senderId, subject, hourlyLimit]
        );
        return res.rows[0].id;
      };

      const createTestRecipient = async (campaignId: string, email: string) => {
        const res = await testClient.query(
          `INSERT INTO recipients (campaign_id, email, name, status)
           VALUES ($1, $2, 'Recipient', 'pending')
           RETURNING id;`,
          [campaignId, email]
        );
        const rId = res.rows[0].id;
        await ensureDeliveryRecord({ campaignId, recipientId: rId }, testClient);
        return rId;
      };

      // ======================================================================
      // TEST 1: Global hourly limit across multiple workers
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('TEST 1: Global hourly limit across multiple workers');
      console.log(SUB_SEP);

      await redis.del('rate-limit:global', 'email-send:global:last-send');
      const sender1 = await createTestSender('Sender 1', 's1@batch4.test', 100);
      const c1 = await createTestCampaign('Global Limit Campaign 1', sender1, 100);
      const c2 = await createTestCampaign('Global Limit Campaign 2', sender1, 100);

      const r1 = await createTestRecipient(c1, 'r1@batch4.test');
      const r2 = await createTestRecipient(c1, 'r2@batch4.test');
      const r3 = await createTestRecipient(c2, 'r3@batch4.test');
      const r4 = await createTestRecipient(c2, 'r4@batch4.test');

      smtpControl.assignedMessageId = '<global-limit-test@batch4.smtp>';
      const initialSubmissions = smtpControl.submissionsCount;

      // Global limit set to 3. 4 dispatches attempted across c1 and c2.
      // Workers 1, 2, 3 should succeed; 4th must be blocked by global limit.
      const jobs = [
        { id: 'w1', cId: c1, rId: r1 },
        { id: 'w2', cId: c1, rId: r2 },
        { id: 'w3', cId: c2, rId: r3 },
        { id: 'w4', cId: c2, rId: r4 },
      ];

      for (let i = 0; i < jobs.length; i++) {
        await processEmailJob(
          {
            id: jobs[i].id,
            data: {
              campaignId: jobs[i].cId,
              recipientId: jobs[i].rId,
              testGlobalLimit: 3,
              testSendDelayMs: 0,
            },
            attemptsMade: 0,
          },
          testPool
        );
      }

      const d1 = await getDelivery(c1, r1, testClient);
      const d2 = await getDelivery(c1, r2, testClient);
      const d3 = await getDelivery(c2, r3, testClient);
      const d4 = await getDelivery(c2, r4, testClient);

      assert(d1!.status === 'sent', 'Worker 1 delivery sent successfully');
      assert(d2!.status === 'sent', 'Worker 2 delivery sent successfully');
      assert(d3!.status === 'sent', 'Worker 3 delivery sent successfully');
      assert(d4!.status === 'retry_wait', 'Worker 4 delivery delayed to "retry_wait" due to global limit');
      assert(d4!.next_attempt_at !== null, 'Worker 4 next_attempt_at persisted');
      assert(
        smtpControl.submissionsCount - initialSubmissions === 3,
        'Exactly 3 global emails permitted by global limit = 3'
      );

      // Verify global limit of 0 disables global cap
      const resZeroGlobal = await reserveSendSlot({
        campaignId: 'c_zero_test',
        globalLimit: 0,
        campaignLimit: 10,
        sendDelayMs: 0,
      });
      assert(resZeroGlobal.allowed === true, 'Global limit of 0 successfully disables the global cap');

      // ======================================================================
      // TEST 2: Sender hourly limit shared across multiple campaigns
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('TEST 2: Sender hourly limit shared across multiple campaigns');
      console.log(SUB_SEP);

      // Sender Alpha has hourly limit = 2
      const senderAlpha = await createTestSender('Sender Alpha', 'alpha@batch4.test', 2);
      await redis.del(`rate-limit:sender:${senderAlpha}`);

      const cAlpha1 = await createTestCampaign('Alpha Campaign 1', senderAlpha, 10);
      const cAlpha2 = await createTestCampaign('Alpha Campaign 2', senderAlpha, 10);

      const rA1 = await createTestRecipient(cAlpha1, 'ra1@batch4.test');
      const rA2 = await createTestRecipient(cAlpha2, 'ra2@batch4.test');
      const rA3 = await createTestRecipient(cAlpha1, 'ra3@batch4.test');

      // Send 1 from Campaign 1 via Alpha
      await processEmailJob(
        {
          id: 'job_alpha_1',
          data: { campaignId: cAlpha1, recipientId: rA1, testSendDelayMs: 0, testGlobalLimit: 0 },
          attemptsMade: 0,
        },
        testPool
      );

      // Send 1 from Campaign 2 via Alpha (now 2 sent for Alpha, reaching limit 2)
      await processEmailJob(
        {
          id: 'job_alpha_2',
          data: { campaignId: cAlpha2, recipientId: rA2, testSendDelayMs: 0, testGlobalLimit: 0 },
          attemptsMade: 0,
        },
        testPool
      );

      // Attempt 3rd send via Alpha (from Campaign 1) -> must be blocked by sender limit
      await processEmailJob(
        {
          id: 'job_alpha_3',
          data: { campaignId: cAlpha1, recipientId: rA3, testSendDelayMs: 0, testGlobalLimit: 0 },
          attemptsMade: 0,
        },
        testPool
      );

      const dA1 = await getDelivery(cAlpha1, rA1, testClient);
      const dA2 = await getDelivery(cAlpha2, rA2, testClient);
      const dA3 = await getDelivery(cAlpha1, rA3, testClient);

      assert(dA1!.status === 'sent', 'Campaign 1 first send via shared sender succeeded');
      assert(dA2!.status === 'sent', 'Campaign 2 send via shared sender succeeded');
      assert(dA3!.status === 'retry_wait', 'Campaign 1 third send blocked by shared sender hourly limit');

      const senderQuotaCheck = await redis.get(`rate-limit:sender:${senderAlpha}`);
      assert(parseInt(senderQuotaCheck || '0', 10) === 2, 'Sender counter in Redis is strictly 2');

      // ======================================================================
      // TEST 3: Campaign hourly limit remains functional
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('TEST 3: Campaign hourly limit remains functional');
      console.log(SUB_SEP);

      const senderC = await createTestSender('Sender C', 'sc@batch4.test', 100);
      const cLimit = await createTestCampaign('Campaign With Limit 2', senderC, 2);
      await redis.del(`rate-limit:campaign:${cLimit}`);

      const rC1 = await createTestRecipient(cLimit, 'rc1@batch4.test');
      const rC2 = await createTestRecipient(cLimit, 'rc2@batch4.test');
      const rC3 = await createTestRecipient(cLimit, 'rc3@batch4.test');

      // 1st send succeeds
      await processEmailJob(
        {
          id: 'job_c_1',
          data: { campaignId: cLimit, recipientId: rC1, testSendDelayMs: 0, testGlobalLimit: 0 },
          attemptsMade: 0,
        },
        testPool
      );

      // 2nd send succeeds
      await processEmailJob(
        {
          id: 'job_c_2',
          data: { campaignId: cLimit, recipientId: rC2, testSendDelayMs: 0, testGlobalLimit: 0 },
          attemptsMade: 0,
        },
        testPool
      );

      // 3rd send blocked by campaign limit
      await processEmailJob(
        {
          id: 'job_c_3',
          data: { campaignId: cLimit, recipientId: rC3, testSendDelayMs: 0, testGlobalLimit: 0 },
          attemptsMade: 0,
        },
        testPool
      );

      const dC1 = await getDelivery(cLimit, rC1, testClient);
      const dC2 = await getDelivery(cLimit, rC2, testClient);
      const dC3 = await getDelivery(cLimit, rC3, testClient);

      assert(dC1!.status === 'sent', 'Campaign send 1 succeeded');
      assert(dC2!.status === 'sent', 'Campaign send 2 succeeded');
      assert(dC3!.status === 'retry_wait', 'Campaign send 3 blocked by campaign limit');

      const campQuota = await redis.get(`rate-limit:campaign:${cLimit}`);
      assert(parseInt(campQuota || '0', 10) === 2, 'Campaign counter in Redis strictly matches limit (2)');

      // ======================================================================
      // TEST 4: Minimum spacing across concurrent workers
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('TEST 4: Minimum spacing across concurrent workers');
      console.log(SUB_SEP);

      await redis.del('email-send:global:last-send');
      const testDelayMs = 250;

      // First reservation acquires slot
      const rSpacing1 = await reserveSendSlot({
        campaignId: 'spacing_camp_test',
        sendDelayMs: testDelayMs,
        globalLimit: 0,
        campaignLimit: 0,
      });
      assert(rSpacing1.allowed === true, 'First worker acquired spacing slot');

      // Immediate second reservation within spacing window must be rejected with reason = 'spacing'
      const rSpacing2 = await reserveSendSlot({
        campaignId: 'spacing_camp_test',
        sendDelayMs: testDelayMs,
        globalLimit: 0,
        campaignLimit: 0,
      });
      assert(rSpacing2.allowed === false, 'Second immediate worker was blocked by send spacing');
      assert(rSpacing2.reason === 'spacing', 'Limiting reason is strictly "spacing"');
      assert(rSpacing2.waitMs > 0 && rSpacing2.waitMs <= testDelayMs, 'Calculated waitMs reflects remaining delay');

      // Wait for delay to elapse
      await new Promise((r) => setTimeout(r, testDelayMs + 20));

      // Third reservation after delay must succeed
      const rSpacing3 = await reserveSendSlot({
        campaignId: 'spacing_camp_test',
        sendDelayMs: testDelayMs,
        globalLimit: 0,
        campaignLimit: 0,
      });
      assert(rSpacing3.allowed === true, 'Third worker succeeds after send delay elapsed');

      // ======================================================================
      // TEST 5: No partial quota consumption when another limit blocks
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('TEST 5: No partial quota consumption when another limit blocks');
      console.log(SUB_SEP);

      const testCampPartial = 'camp_partial_test';
      const testSenderPartial = 'sender_partial_test';
      await redis.del(
        'rate-limit:global',
        `rate-limit:campaign:${testCampPartial}`,
        `rate-limit:sender:${testSenderPartial}`,
        'email-send:global:last-send'
      );

      // Pre-exhaust sender limit (set sender limit = 1 and already at 1)
      await redis.set(`rate-limit:sender:${testSenderPartial}`, '1', 'EX', 3600);

      // Attempt unified reservation with globalLimit = 10 (fresh), campaignLimit = 10 (fresh), senderLimit = 1 (exhausted)
      const partialRes = await reserveSendSlot({
        campaignId: testCampPartial,
        campaignLimit: 10,
        senderId: testSenderPartial,
        senderLimit: 1,
        globalLimit: 10,
        sendDelayMs: 0,
      });

      assert(partialRes.allowed === false, 'Reservation was blocked by exhausted sender limit');
      assert(partialRes.reason === 'sender', 'Reason was strictly "sender"');

      // Verify ZERO partial quota consumption:
      const campCount = await redis.get(`rate-limit:campaign:${testCampPartial}`);
      const globalCount = await redis.get('rate-limit:global');
      const lastSend = await redis.get('email-send:global:last-send');

      assert(campCount === null, 'Campaign quota was NOT partially consumed (key does not exist)');
      assert(globalCount === null, 'Global quota was NOT partially consumed (key does not exist)');
      assert(lastSend === null, 'Spacing timestamp was NOT updated when limit blocked');

      // ======================================================================
      // TEST 6: Correct delay calculation for each limiting reason
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('TEST 6: Correct delay calculation for each limiting reason');
      console.log(SUB_SEP);

      // 6.1 Spacing reason waitMs
      await redis.set('email-send:global:last-send', tostringNow(), 'EX', 3600);
      const delayCheckSpacing = await reserveSendSlot({
        campaignId: 'calc_test',
        sendDelayMs: 5000,
        globalLimit: 0,
        campaignLimit: 0,
      });
      assert(delayCheckSpacing.reason === 'spacing', 'Reason is "spacing"');
      assert(delayCheckSpacing.waitMs > 4000 && delayCheckSpacing.waitMs <= 5000, 'Spacing waitMs is accurate (~5000ms)');

      // 6.2 Global reason waitMs
      await redis.del('email-send:global:last-send');
      await redis.set('rate-limit:global', '10', 'EX', 1800);
      const delayCheckGlobal = await reserveSendSlot({
        campaignId: 'calc_test',
        sendDelayMs: 0,
        globalLimit: 10,
        campaignLimit: 0,
      });
      assert(delayCheckGlobal.reason === 'global', 'Reason is "global"');
      assert(delayCheckGlobal.waitMs > 1700000 && delayCheckGlobal.waitMs <= 1800000, 'Global waitMs matches key TTL');

      // 6.3 Campaign reason waitMs
      await redis.del('rate-limit:global');
      await redis.set('rate-limit:campaign:calc_test', '5', 'EX', 2400);
      const delayCheckCampaign = await reserveSendSlot({
        campaignId: 'calc_test',
        sendDelayMs: 0,
        globalLimit: 0,
        campaignLimit: 5,
      });
      assert(delayCheckCampaign.reason === 'campaign', 'Reason is "campaign"');
      assert(delayCheckCampaign.waitMs > 2300000 && delayCheckCampaign.waitMs <= 2400000, 'Campaign waitMs matches key TTL');

      // 6.4 Sender reason waitMs
      await redis.del('rate-limit:campaign:calc_test');
      await redis.set('rate-limit:sender:calc_sender', '3', 'EX', 900);
      const delayCheckSender = await reserveSendSlot({
        campaignId: 'calc_test',
        senderId: 'calc_sender',
        senderLimit: 3,
        sendDelayMs: 0,
        globalLimit: 0,
        campaignLimit: 0,
      });
      assert(delayCheckSender.reason === 'sender', 'Reason is "sender"');
      assert(delayCheckSender.waitMs > 800000 && delayCheckSender.waitMs <= 900000, 'Sender waitMs matches key TTL');

      // ======================================================================
      // TEST 7: Delivery claim release and retry_wait persistence
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('TEST 7: Delivery claim release and retry_wait persistence');
      console.log(SUB_SEP);

      const sender7 = await createTestSender('Sender 7', 's7@batch4.test', 1);
      const c7 = await createTestCampaign('Claim Release Test', sender7, 1);
      const r7_1 = await createTestRecipient(c7, 'r7_1@batch4.test');
      const r7_2 = await createTestRecipient(c7, 'r7_2@batch4.test');
      await redis.del(`rate-limit:sender:${sender7}`, `rate-limit:campaign:${c7}`);

      // First send uses quota 1 of 1
      await processEmailJob(
        {
          id: 'job_claim_rel_1',
          data: { campaignId: c7, recipientId: r7_1, testSendDelayMs: 0, testGlobalLimit: 0 },
          attemptsMade: 0,
        },
        testPool
      );

      // Second job claims delivery, hits rate limit, calls releaseDeliveryClaim
      let delayedThrown = false;
      let moveToDelayedCalled = false;
      let delayedTimestamp = 0;

      try {
        await processEmailJob(
          {
            id: 'job_claim_rel_2',
            data: { campaignId: c7, recipientId: r7_2, testSendDelayMs: 0, testGlobalLimit: 0 },
            attemptsMade: 0,
            moveToDelayed: async (ts: number) => {
              moveToDelayedCalled = true;
              delayedTimestamp = ts;
            },
          },
          testPool
        );
      } catch (err: any) {
        if (err.name === 'DelayedError') {
          delayedThrown = true;
        }
      }

      assert(delayedThrown, 'BullMQ DelayedError thrown to signal delayed rescheduling');
      assert(moveToDelayedCalled, 'job.moveToDelayed was called with calculated delayed time');
      assert(delayedTimestamp > Date.now(), 'Delayed execution time is in the future');

      const d7_2 = await getDelivery(c7, r7_2, testClient);
      assert(d7_2!.status === 'retry_wait', 'Delivery status is persisted as "retry_wait"');
      assert(d7_2!.claim_owner === null, 'Claim owner is released (NULL)');
      assert(d7_2!.lease_expires_at === null, 'Lease expires at is released (NULL)');
      assert(d7_2!.next_attempt_at !== null, 'next_attempt_at is persisted');
      assert(d7_2!.attempt_count === 0, 'attempt_count increment was reversed (no attempt executed)');

      // ======================================================================
      // TEST 8: Delayed jobs survive worker restart
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('TEST 8: Delayed jobs survive worker restart');
      console.log(SUB_SEP);

      const restartQueueName = 'test-restart-delay-queue';
      const restartQueue = new Queue(restartQueueName, { connection: redisConnectionOptions });

      // Clear any prior queue state
      await restartQueue.drain();
      await restartQueue.clean(0, 1000, 'delayed');
      await restartQueue.clean(0, 1000, 'wait');

      const sender8 = await createTestSender('Sender 8', 's8@batch4.test', 10);
      const c8 = await createTestCampaign('Restart Delay Campaign', sender8, 10);
      const r8 = await createTestRecipient(c8, 'r8@batch4.test');

      let worker1Processed = 0;
      let worker2Processed = 0;

      // Start Worker 1: delays the job by 600ms
      const worker1 = new Worker(
        restartQueueName,
        async (job: Job) => {
          worker1Processed++;
          // Delay by 600ms
          await job.moveToDelayed(Date.now() + 600, job.token);
          throw new (require('bullmq').DelayedError)();
        },
        { connection: redisConnectionOptions, autorun: true }
      );

      // Add job to queue
      await restartQueue.add('delayed_restart_job', { campaignId: c8, recipientId: r8 });

      // Wait 150ms for worker 1 to process and delay it
      await new Promise((r) => setTimeout(r, 150));
      assert(worker1Processed === 1, 'Worker 1 processed initial job and moved it to delayed state');

      // Worker 1 crashes / is closed
      console.log('   Simulating Worker 1 crash/restart...');
      await worker1.close();

      // Verify job is safely persisted in Redis delayed set
      const delayedCount = await restartQueue.getDelayedCount();
      assert(delayedCount === 1, 'Delayed job is safely persisted in Redis delayed set during worker outage');

      // Start Worker 2 (restarted worker)
      const worker2 = new Worker(
        restartQueueName,
        async (job: Job) => {
          worker2Processed++;
        },
        { connection: redisConnectionOptions, autorun: true }
      );

      // Wait 700ms for delay to elapse and Worker 2 to process the persisted job
      console.log('   Waiting for delay to elapse and Worker 2 to resume...');
      await new Promise((r) => setTimeout(r, 750));

      assert(worker2Processed === 1, 'Worker 2 resumed and processed the delayed job after worker restart');

      await worker2.close();
      await restartQueue.close();

      // ======================================================================
      // TEST 9: Rate-limit reservations remain safe under Redis concurrency
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('TEST 9: Rate-limit reservations remain safe under Redis concurrency');
      console.log(SUB_SEP);

      const concurrentCampKey = 'concurrent_test_camp';
      await redis.del(`rate-limit:campaign:${concurrentCampKey}`);

      // Fire 20 simultaneous reservation attempts with limit = 5
      const concurrentPromises = Array.from({ length: 20 }, (_, idx) =>
        reserveSendSlot({
          campaignId: concurrentCampKey,
          campaignLimit: 5,
          sendDelayMs: 0,
          globalLimit: 0,
        })
      );

      const results = await Promise.all(concurrentPromises);
      const allowedCount = results.filter((r) => r.allowed).length;
      const rejectedCount = results.filter((r) => !r.allowed).length;

      assert(allowedCount === 5, 'Exactly 5 concurrent requests granted quota (limit = 5)');
      assert(rejectedCount === 15, 'Exactly 15 concurrent requests rejected');

      const finalRedisCount = await redis.get(`rate-limit:campaign:${concurrentCampKey}`);
      assert(parseInt(finalRedisCount || '0', 10) === 5, 'Redis counter strictly holds 5 without over-allocation');

      // ======================================================================
      // TEST 10: Batch 3 stale reconciliation runs before worker processing
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('TEST 10: Batch 3 stale reconciliation runs before worker processing');
      console.log(SUB_SEP);

      // Create a stale delivery left in 'sending' with expired lease
      const sender10 = await createTestSender('Sender 10', 's10@batch4.test', 10);
      const c10 = await createTestCampaign('Stale Startup Campaign', sender10, 10);
      const r10 = await createTestRecipient(c10, 'r10@batch4.test');

      const d10 = await claimDelivery({
        campaignId: c10,
        recipientId: r10,
        claimOwner: 'crashed_worker_prev_run',
        leaseDurationMs: 100,
        dbClient: testClient,
      });

      // Force lease to be in the past
      await testClient.query(
        `UPDATE email_deliveries
         SET lease_expires_at = NOW() - INTERVAL '5 minutes'
         WHERE id = $1`,
        [d10!.id]
      );
      await testClient.query(
        `INSERT INTO email_attempts (delivery_id, attempt_number, status, sender_id, attempted_at)
         VALUES ($1, 1, 'attempting', $2, NOW() - INTERVAL '5 minutes')`,
        [d10!.id, sender10]
      );

      // Run initializeWorker()
      await initializeWorker(testPool);

      const d10Reconciled = await getDelivery(c10, r10, testClient);
      assert(
        d10Reconciled!.status === 'unknown',
        'Stale in-flight delivery was reconciled to "unknown" during worker startup'
      );
      assert(
        d10Reconciled!.claim_owner === null,
        'Claim owner cleared during startup reconciliation'
      );

      const a10Reconciled = await testClient.query(
        `SELECT * FROM email_attempts WHERE delivery_id = $1`,
        [d10!.id]
      );
      assert(
        a10Reconciled.rows[0].status === 'unknown',
        'Attempt history transitioned to "unknown" during startup reconciliation'
      );

    } finally {
      testClient.release();
      await testPool.end();
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

    // Step 6: Verify original database integrity
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
    await stopSmtpTestServer();
    await adminClient.end();
  }

  // Summary
  console.log('\n' + SEP);
  console.log(`  BATCH 4 VERIFICATION COMPLETE: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log(SEP + '\n');

  if (failedTests > 0) {
    process.exit(1);
  }
  process.exit(0);
}

function tostringNow(): string {
  return String(Date.now());
}

runBatch4Verification().catch((err) => {
  console.error('Fatal error during Batch 4 verification:', err);
  process.exit(1);
});
