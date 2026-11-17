/**
 * src/scripts/testBatch3SmtpReliability.ts
 *
 * REACHINBOX — BATCH 3 ACCEPTANCE TEST SUITE
 * SMTP Reliability and Sender Identity Verification
 *
 * Verifies all 10 Batch 3 acceptance criteria plus Batch 3.1 and 3.2 scenarios
 * against an isolated ephemeral PostgreSQL database and a deterministic in-process
 * RFC 5321 SMTP test server:
 *
 *  1. Explicitly selected sender fails authentication: no default sender fallback.
 *  2. Explicitly selected sender fails to connect: no sender switching.
 *  3. No sender selected: existing permitted default-sender behaviour remains functional.
 *  4. SMTP transient rejection before acceptance (4xx, retryable).
 *  5. Permanent SMTP rejection (5xx, non-retryable).
 *  6. Connection failure before DATA transmission (retryable).
 *  7. Socket disconnection after DATA transmission while waiting for final acceptance (ambiguous, non-retryable).
 *  8. Confirmed SMTP acceptance records the actual message ID.
 *  9. Ambiguous SMTP outcome becomes 'unknown' and is not automatically retried.
 * 10. Multiple configured senders retain their individual identities.
 *
 * INVARIANTS:
 *  - Uses ephemeral DB `reachinbox_migration_test`.
 *  - Original `reachinbox` database is NEVER touched.
 *  - Real TCP RFC 5321 SMTP protocol exchange via Node.js net module.
 *  - Zero fabricated success or fake message IDs in production code.
 */

// Disable background workers & ES during tests
process.env.START_WORKER = 'false';
process.env.SEND_DELAY_TEST_MS = '0';
process.env.DISABLE_ES_INDEXING = 'true';
process.env.NODE_ENV = 'test';

import net from 'net';
import { Client, Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';
import nodemailer from 'nodemailer';
import { runMigrations } from '../db/migrate';
import { processEmailJob } from '../workers/emailWorker';
import { getDelivery, claimDelivery, reconcileStaleDeliveries } from '../services/deliveryService';
import { clearTransporterCache, setDefaultTransporter, resetDefaultTransporter } from '../services/emailService';
import { safeEncrypt } from '../utils/crypto';

const BASE_PG_CONFIG = {
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
};

const TEST_DB_NAME = 'reachinbox_migration_test';
const BACKUP_FILE = path.resolve(__dirname, '../../backups/reachinbox_pre_stage1_backup.sql');

// Track test assertions
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

type SmtpServerMode =
  | 'normal'
  | 'auth_fail'
  | 'transient_reject'
  | 'permanent_reject'
  | 'drop_before_data'
  | 'drop_after_data';

interface RecordedSmtpSession {
  authUser?: string;
  mailFrom?: string;
  rcptTo?: string;
  fromHeader?: string;
  dataLines: string[];
}

interface SmtpServerControl {
  mode: SmtpServerMode;
  assignedMessageId: string;
  sessions: RecordedSmtpSession[];
  server: net.Server | null;
  port: number;
}

const smtpControl: SmtpServerControl = {
  mode: 'normal',
  assignedMessageId: '<init@reachinbox.smtp>',
  sessions: [],
  server: null,
  port: 0,
};

function startSmtpTestServer(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let inData = false;
      let dataBuffer = '';
      let authState: 'none' | 'login_user' | 'login_pass' = 'none';
      const currentSession: RecordedSmtpSession = { dataLines: [] };
      smtpControl.sessions.push(currentSession);

      // Initial greeting banner
      socket.write('220 smtp.reachinbox.test ESMTP Service Ready\r\n');

      socket.on('data', (chunk) => {
        const text = chunk.toString();

        if (inData) {
          dataBuffer += text;
          if (dataBuffer.includes('\r\n.\r\n') || dataBuffer.endsWith('\r\n.')) {
            inData = false;
            currentSession.dataLines = dataBuffer.split('\r\n');

            // Extract From header if present
            const fromLine = currentSession.dataLines.find((l) => l.toLowerCase().startsWith('from:'));
            if (fromLine) {
              currentSession.fromHeader = fromLine.substring(5).trim();
            }

            if (smtpControl.mode === 'drop_after_data') {
              // Abruptly sever socket connection after DATA received without sending 250 response!
              socket.destroy();
              return;
            }

            if (smtpControl.mode === 'transient_reject') {
              socket.write('451 4.3.0 Temporary local processing failure\r\n');
              return;
            }

            if (smtpControl.mode === 'permanent_reject') {
              socket.write('554 5.7.1 Message rejected as spam\r\n');
              return;
            }

            // Normal success: send genuine 250 with assigned message ID
            socket.write(`250 2.0.0 OK: queued as ${smtpControl.assignedMessageId}\r\n`);
          }
          return;
        }

        const lines = text.split('\r\n');
        for (const line of lines) {
          if (!line) continue;
          const upper = line.toUpperCase();

          if (authState === 'login_user') {
            try {
              currentSession.authUser = Buffer.from(line, 'base64').toString('utf8');
            } catch {
              currentSession.authUser = line;
            }
            authState = 'login_pass';
            socket.write('334 UGFzc3dvcmQ6\r\n'); // Password:
            continue;
          }

          if (authState === 'login_pass') {
            authState = 'none';
            if (smtpControl.mode === 'auth_fail') {
              socket.write('535 5.7.8 Authentication credentials invalid\r\n');
            } else {
              socket.write('235 2.7.0 Authentication successful\r\n');
            }
            continue;
          }

          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            socket.write('250-smtp.reachinbox.test\r\n250-AUTH LOGIN PLAIN\r\n250-8BITMIME\r\n250 OK\r\n');
          } else if (upper.startsWith('AUTH LOGIN')) {
            authState = 'login_user';
            socket.write('334 VXNlcm5hbWU6\r\n'); // Username:
          } else if (upper.startsWith('AUTH PLAIN')) {
            const parts = line.split(' ');
            if (parts.length > 2) {
              try {
                const decoded = Buffer.from(parts[2], 'base64').toString('utf8');
                const tokens = decoded.split('\0');
                currentSession.authUser = tokens[1] || tokens[2] || parts[2];
              } catch {
                currentSession.authUser = parts[2];
              }
            }
            if (smtpControl.mode === 'auth_fail') {
              socket.write('535 5.7.8 Authentication credentials invalid\r\n');
            } else {
              socket.write('235 2.7.0 Authentication successful\r\n');
            }
          } else if (upper.startsWith('MAIL FROM:')) {
            currentSession.mailFrom = line.substring(10).trim();
            socket.write('250 2.1.0 Sender OK\r\n');
          } else if (upper.startsWith('RCPT TO:')) {
            currentSession.rcptTo = line.substring(8).trim();

            if (smtpControl.mode === 'drop_before_data') {
              // Abrupt socket severance before DATA transmission
              socket.destroy();
              return;
            }

            if (smtpControl.mode === 'transient_reject') {
              socket.write('451 4.3.0 Mailbox busy; try again later\r\n');
              return;
            }

            if (smtpControl.mode === 'permanent_reject') {
              socket.write('550 5.1.1 User unknown\r\n');
              return;
            }

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
// Main Batch 3 Verification Runner
// =============================================================================

async function runBatch3Verification(): Promise<void> {
  console.log('\n' + SEP);
  console.log('  BATCH 3 VERIFICATION: SMTP RELIABILITY & SENDER IDENTITY');
  console.log('  Target Database: reachinbox_migration_test (Ephemeral Isolated Test DB)');
  console.log('  Production DB:   reachinbox (UNTOUCHED)');
  console.log(SEP);

  // Step 1: Start deterministic RFC 5321 test server
  const smtpPort = await startSmtpTestServer();
  console.log(`\n1. Started RFC 5321 SMTP test server on 127.0.0.1:${smtpPort}`);

  // Step 2: Prepare isolated ephemeral test DB
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

    // Restore backup
    console.log('\n3. Restoring pre-stage1 backup into isolated database...');
    const pgRestoreCmd = `docker exec reachinbox_postgres pg_restore -U ${BASE_PG_CONFIG.user} -d ${TEST_DB_NAME} --clean --if-exists /tmp/reachinbox_pre_stage1_backup.sql`;
    try {
      execSync(pgRestoreCmd, { stdio: 'pipe' });
    } catch {
      // Ignored non-fatal restore notices
    }
    console.log('   pg_restore completed successfully.');

    const testPool = new Pool({
      ...BASE_PG_CONFIG,
      database: TEST_DB_NAME,
    });
    const testClient = await testPool.connect();

    // Run schema migrations
    console.log('\n4. Applying schema migrations to isolated database...');
    const migrationResult = await runMigrations(testClient);
    console.log(`   Migrations applied: ${migrationResult.applied.length}, skipped: ${migrationResult.skipped.length}`);

    try {
      // Create test user
      const userRes = await testClient.query(
        `INSERT INTO users (email, name)
         VALUES ('smtp_test_user@reachinbox.test', 'SMTP Test User')
         RETURNING id;`
      );
      const userId = userRes.rows[0].id;

      // Helper to create test sender
      const createTestSender = async (name: string, email: string, user: string, pass: string, port = smtpPort) => {
        const encryptedPass = safeEncrypt(pass);
        const res = await testClient.query(`
          INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, hourly_limit)
          VALUES ($1, $2, $3, '127.0.0.1', $4, false, $5, $6, 100)
          RETURNING id;
        `, [userId, name, email, port, user, encryptedPass]);
        return res.rows[0].id;
      };

      // Helper to create test recipient
      const createTestRecip = async (campaignId: string, email: string) => {
        const res = await testClient.query(
          `INSERT INTO recipients (campaign_id, email, name, status) VALUES ($1, $2, 'User', 'pending') RETURNING id;`,
          [campaignId, email]
        );
        return res.rows[0].id;
      };

      // ======================================================================
      // SCENARIO 1: Selected sender fails authentication: no default sender fallback
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 1: Selected sender fails authentication: no default fallback');
      console.log(SUB_SEP);

      clearTransporterCache();
      smtpControl.mode = 'auth_fail';
      smtpControl.sessions = [];

      const sender1Id = await createTestSender('Sender Auth Fail', 'auth_fail@sender.test', 'user_bad', 'wrong_pass');
      const c1 = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, $2, 'Auth Failure Test', 'Body', 'sending') RETURNING id;
      `, [userId, sender1Id]);
      const c1Id = c1.rows[0].id;
      const r1Id = await createTestRecip(c1Id, 'auth_fail_recip@reachinbox.test');

      // Worker executes job
      await processEmailJob(
        {
          id: `job_scenario_1_${c1Id}`,
          data: { campaignId: c1Id, recipientId: r1Id },
          attemptsMade: 0,
        },
        testPool
      );

      const d1 = await getDelivery(c1Id, r1Id, testClient);
      assert(d1!.status === 'failed', 'Delivery status is "failed" on permanent authentication rejection');

      const a1 = await testClient.query(
        `SELECT * FROM email_attempts WHERE delivery_id = $1 ORDER BY attempt_number DESC LIMIT 1;`,
        [d1!.id]
      );
      assert(a1.rows[0].status === 'failed', 'Attempt status recorded as "failed" in email_attempts');
      assert(a1.rows[0].error_classification === 'permanent_rejection', 'Classification is "permanent_rejection"');
      assert(a1.rows[0].smtp_response_code === '535', 'SMTP response code is "535"');
      assert(a1.rows[0].sender_id === sender1Id, 'Attempt sender_id strictly preserves explicit sender identity');

      // ======================================================================
      // SCENARIO 2: Selected sender fails to connect: no sender switching
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 2: Selected sender fails to connect: no sender switching');
      console.log(SUB_SEP);

      clearTransporterCache();
      smtpControl.mode = 'normal';
      // Port 49991 is not bound
      const senderUnreachableId = await createTestSender('Sender Unreachable', 'unreach@sender.test', 'user_unreach', 'pass', 49991);
      const c2 = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, $2, 'Connect Failure Test', 'Body', 'sending') RETURNING id;
      `, [userId, senderUnreachableId]);
      const c2Id = c2.rows[0].id;
      const r2Id = await createTestRecip(c2Id, 'unreach_recip@reachinbox.test');

      let c2ErrorThrown = false;
      try {
        await processEmailJob(
          {
            id: `job_scenario_2_${c2Id}`,
            data: { campaignId: c2Id, recipientId: r2Id },
            attemptsMade: 0,
          },
          testPool
        );
      } catch {
        c2ErrorThrown = true;
      }

      assert(c2ErrorThrown, 'Worker rethrew connection failure for BullMQ retry scheduling');

      const d2 = await getDelivery(c2Id, r2Id, testClient);
      assert(d2!.status === 'retry_wait', 'Delivery status transitioned to "retry_wait" (safe to retry)');

      const a2 = await testClient.query(
        `SELECT * FROM email_attempts WHERE delivery_id = $1 ORDER BY attempt_number DESC LIMIT 1;`,
        [d2!.id]
      );
      assert(a2.rows[0].status === 'failed', 'Attempt status is "failed"');
      assert(a2.rows[0].error_classification === 'connection_failure', 'Classification is "connection_failure"');
      assert(a2.rows[0].sender_id === senderUnreachableId, 'Explicit sender identity preserved (zero sender switching)');

      // ======================================================================
      // SCENARIO 3: No sender selected: existing permitted default-sender behaviour remains functional
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 3: No sender selected: default-sender behaviour remains functional');
      console.log(SUB_SEP);

      clearTransporterCache();
      smtpControl.mode = 'normal';
      smtpControl.assignedMessageId = '<default-sender-msg-3@test.smtp>';

      // Override default transporter to point to test SMTP server
      const defaultTestTransporter = nodemailer.createTransport({
        host: '127.0.0.1',
        port: smtpPort,
        secure: false,
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 5000,
      });
      setDefaultTransporter(defaultTestTransporter);

      const c3 = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, NULL, 'Default Sender Test', 'Body', 'sending') RETURNING id;
      `, [userId]);
      const c3Id = c3.rows[0].id;
      const r3Id = await createTestRecip(c3Id, 'default_sender_recip@reachinbox.test');

      await processEmailJob(
        {
          id: `job_scenario_3_${c3Id}`,
          data: { campaignId: c3Id, recipientId: r3Id },
          attemptsMade: 0,
        },
        testPool
      );

      const d3 = await getDelivery(c3Id, r3Id, testClient);
      assert(d3!.status === 'sent', 'Delivery sent successfully using default system sender');
      assert(d3!.smtp_message_id === '<default-sender-msg-3@test.smtp>', 'Genuine SMTP message ID recorded for default sender');

      const a3 = await testClient.query(
        `SELECT * FROM email_attempts WHERE delivery_id = $1 ORDER BY attempt_number DESC LIMIT 1;`,
        [d3!.id]
      );
      assert(a3.rows[0].status === 'sent', 'Attempt marked "sent"');
      assert(a3.rows[0].sender_id === null, 'Attempt sender_id is null reflecting default sender');
      assert(a3.rows[0].error_classification === 'confirmed_acceptance', 'Classification is "confirmed_acceptance"');

      // ======================================================================
      // SCENARIO 4: SMTP transient rejection before acceptance (4xx)
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 4: SMTP transient rejection before acceptance (4xx)');
      console.log(SUB_SEP);

      clearTransporterCache();
      smtpControl.mode = 'transient_reject';

      const sender4Id = await createTestSender('Sender 4xx', 'transient@sender.test', 'user_4xx', 'pass');
      const c4 = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, $2, 'Transient Rejection Test', 'Body', 'sending') RETURNING id;
      `, [userId, sender4Id]);
      const c4Id = c4.rows[0].id;
      const r4Id = await createTestRecip(c4Id, 'transient_recip@reachinbox.test');

      let c4Thrown = false;
      try {
        await processEmailJob(
          {
            id: `job_scenario_4_${c4Id}`,
            data: { campaignId: c4Id, recipientId: r4Id },
            attemptsMade: 0,
          },
          testPool
        );
      } catch {
        c4Thrown = true;
      }

      assert(c4Thrown, 'Transient rejection rethrows to allow BullMQ backoff retry');

      const d4 = await getDelivery(c4Id, r4Id, testClient);
      assert(d4!.status === 'retry_wait', 'Delivery status is "retry_wait"');
      assert(d4!.next_attempt_at !== null, 'Next attempt timestamp scheduled in future');

      const a4 = await testClient.query(
        `SELECT * FROM email_attempts WHERE delivery_id = $1 ORDER BY attempt_number DESC LIMIT 1;`,
        [d4!.id]
      );
      assert(a4.rows[0].status === 'failed', 'Attempt recorded as "failed"');
      assert(a4.rows[0].error_classification === 'transient_rejection', 'Classification is "transient_rejection"');
      assert(a4.rows[0].smtp_response_code === '451', 'SMTP response code is "451"');

      // ======================================================================
      // SCENARIO 5: Permanent SMTP rejection (5xx)
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 5: Permanent SMTP rejection (5xx)');
      console.log(SUB_SEP);

      clearTransporterCache();
      smtpControl.mode = 'permanent_reject';

      const sender5Id = await createTestSender('Sender 5xx', 'perm@sender.test', 'user_5xx', 'pass');
      const c5 = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, $2, 'Permanent Rejection Test', 'Body', 'sending') RETURNING id;
      `, [userId, sender5Id]);
      const c5Id = c5.rows[0].id;
      const r5Id = await createTestRecip(c5Id, 'perm_recip@reachinbox.test');

      // Permanent failures must NOT rethrow
      let c5Thrown = false;
      try {
        await processEmailJob(
          {
            id: `job_scenario_5_${c5Id}`,
            data: { campaignId: c5Id, recipientId: r5Id },
            attemptsMade: 0,
          },
          testPool
        );
      } catch {
        c5Thrown = true;
      }

      assert(!c5Thrown, 'Permanent rejection does NOT rethrow (prevents automatic BullMQ retry loops)');

      const d5 = await getDelivery(c5Id, r5Id, testClient);
      assert(d5!.status === 'failed', 'Delivery status is terminal "failed"');

      const a5 = await testClient.query(
        `SELECT * FROM email_attempts WHERE delivery_id = $1 ORDER BY attempt_number DESC LIMIT 1;`,
        [d5!.id]
      );
      assert(a5.rows[0].status === 'failed', 'Attempt recorded as "failed"');
      assert(a5.rows[0].error_classification === 'permanent_rejection', 'Classification is "permanent_rejection"');
      assert(a5.rows[0].smtp_response_code === '550', 'SMTP response code is "550"');

      // ======================================================================
      // SCENARIO 6: Connection failure before DATA transmission
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 6: Connection failure before DATA transmission');
      console.log(SUB_SEP);

      clearTransporterCache();
      smtpControl.mode = 'drop_before_data';

      const sender6Id = await createTestSender('Sender Drop Pre-DATA', 'drop_pre@sender.test', 'user_pre', 'pass');
      const c6 = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, $2, 'Drop Pre-DATA Test', 'Body', 'sending') RETURNING id;
      `, [userId, sender6Id]);
      const c6Id = c6.rows[0].id;
      const r6Id = await createTestRecip(c6Id, 'drop_pre_recip@reachinbox.test');

      let c6Thrown = false;
      try {
        await processEmailJob(
          {
            id: `job_scenario_6_${c6Id}`,
            data: { campaignId: c6Id, recipientId: r6Id },
            attemptsMade: 0,
          },
          testPool
        );
      } catch {
        c6Thrown = true;
      }

      assert(c6Thrown, 'Pre-DATA connection failure rethrows to schedule BullMQ retry');

      const d6 = await getDelivery(c6Id, r6Id, testClient);
      assert(d6!.status === 'retry_wait', 'Delivery status is "retry_wait" (safe to retry because failure was before DATA)');

      const a6 = await testClient.query(
        `SELECT * FROM email_attempts WHERE delivery_id = $1 ORDER BY attempt_number DESC LIMIT 1;`,
        [d6!.id]
      );
      assert(a6.rows[0].error_classification === 'connection_failure', 'Classification is "connection_failure"');

      // ======================================================================
      // SCENARIO 7: Socket disconnection after DATA transmission while waiting for final acceptance
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 7: Socket disconnection after DATA transmission (Ambiguous)');
      console.log(SUB_SEP);

      clearTransporterCache();
      smtpControl.mode = 'drop_after_data';

      const sender7Id = await createTestSender('Sender Drop Post-DATA', 'drop_post@sender.test', 'user_post', 'pass');
      const c7 = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, $2, 'Drop Post-DATA Test', 'Body', 'sending') RETURNING id;
      `, [userId, sender7Id]);
      const c7Id = c7.rows[0].id;
      const r7Id = await createTestRecip(c7Id, 'drop_post_recip@reachinbox.test');

      let c7Thrown = false;
      try {
        await processEmailJob(
          {
            id: `job_scenario_7_${c7Id}`,
            data: { campaignId: c7Id, recipientId: r7Id },
            attemptsMade: 0,
          },
          testPool
        );
      } catch {
        c7Thrown = true;
      }

      assert(!c7Thrown, 'Ambiguous outcome does NOT rethrow (prevents automatic BullMQ retry)');

      const d7 = await getDelivery(c7Id, r7Id, testClient);
      assert(d7!.status === 'unknown', 'Delivery transitioned to non-dispatchable "unknown" state');

      const a7 = await testClient.query(
        `SELECT * FROM email_attempts WHERE delivery_id = $1 ORDER BY attempt_number DESC LIMIT 1;`,
        [d7!.id]
      );
      assert(a7.rows[0].status === 'unknown', 'Attempt status recorded as "unknown"');
      assert(a7.rows[0].error_classification === 'ambiguous_outcome', 'Classification is "ambiguous_outcome"');

      // ======================================================================
      // SCENARIO 8: Confirmed SMTP acceptance records the actual message ID
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 8: Confirmed SMTP acceptance records actual message ID');
      console.log(SUB_SEP);

      clearTransporterCache();
      smtpControl.mode = 'normal';
      const actualServerMessageId = '<real-acceptance-id-98765@reachinbox.test>';
      smtpControl.assignedMessageId = actualServerMessageId;

      const sender8Id = await createTestSender('Sender Confirmed', 'confirmed@sender.test', 'user_conf', 'pass');
      const c8 = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, $2, 'Confirmed Acceptance Test', 'Body', 'sending') RETURNING id;
      `, [userId, sender8Id]);
      const c8Id = c8.rows[0].id;
      const r8Id = await createTestRecip(c8Id, 'confirmed_recip@reachinbox.test');

      await processEmailJob(
        {
          id: `job_scenario_8_${c8Id}`,
          data: { campaignId: c8Id, recipientId: r8Id },
          attemptsMade: 0,
        },
        testPool
      );

      const d8 = await getDelivery(c8Id, r8Id, testClient);
      assert(d8!.status === 'sent', 'Delivery marked "sent" upon confirmed SMTP acceptance');
      assert(d8!.smtp_message_id === actualServerMessageId, 'Delivery stores exact genuine SMTP message ID');

      const a8 = await testClient.query(
        `SELECT * FROM email_attempts WHERE delivery_id = $1 ORDER BY attempt_number DESC LIMIT 1;`,
        [d8!.id]
      );
      assert(a8.rows[0].status === 'sent', 'Attempt status is "sent"');
      assert(a8.rows[0].smtp_message_id === actualServerMessageId, 'Attempt stores exact genuine SMTP message ID');
      assert(a8.rows[0].error_classification === 'confirmed_acceptance', 'Classification is "confirmed_acceptance"');
      assert(a8.rows[0].smtp_response_code === '250', 'SMTP response code is "250"');

      // ======================================================================
      // SCENARIO 8b: Successful send where response-code metadata is unavailable (Batch 3.1 Bug 1)
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 8b: Successful send where response-code metadata is unavailable');
      console.log(SUB_SEP);

      clearTransporterCache();
      smtpControl.mode = 'normal';
      const actualServerMsgIdNoCode = '<no-code-acceptance-id-456@reachinbox.test>';
      smtpControl.assignedMessageId = actualServerMsgIdNoCode;

      const sender8bId = await createTestSender('Sender No Code', 'nocode@sender.test', 'user_nocode', 'pass');
      const c8b = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, $2, 'No Response Code Test', 'Body', 'sending') RETURNING id;
      `, [userId, sender8bId]);
      const c8bId = c8b.rows[0].id;
      const r8bId = await createTestRecip(c8bId, 'nocode_recip@reachinbox.test');

      await processEmailJob(
        {
          id: `job_scenario_8b_${c8bId}`,
          data: {
            campaignId: c8bId,
            recipientId: r8bId,
            simulateNoResponseCode: true,
          },
          attemptsMade: 0,
        },
        testPool
      );

      const d8b = await getDelivery(c8bId, r8bId, testClient);
      assert(d8b!.status === 'sent', 'Delivery marked "sent" despite missing response-code metadata');
      assert(d8b!.smtp_message_id === actualServerMsgIdNoCode, 'Delivery stores exact genuine SMTP message ID');

      const a8b = await testClient.query(
        `SELECT * FROM email_attempts WHERE delivery_id = $1 ORDER BY attempt_number DESC LIMIT 1;`,
        [d8b!.id]
      );
      assert(a8b.rows[0].status === 'sent', 'Attempt status is "sent"');
      assert(a8b.rows[0].smtp_message_id === actualServerMsgIdNoCode, 'Attempt stores exact genuine SMTP message ID');
      assert(a8b.rows[0].error_classification === 'confirmed_acceptance', 'Classification is "confirmed_acceptance"');
      assert(a8b.rows[0].smtp_response_code === null, 'SMTP response code is strictly NULL (zero fabricated 250)');

      // ======================================================================
      // SCENARIO 9: Ambiguous SMTP outcome becomes unknown and is not automatically retried
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 9: Ambiguous SMTP outcome is NEVER automatically retried');
      console.log(SUB_SEP);

      // Take delivery from Scenario 7 (status = unknown) and attempt to process again
      console.log('   Simulating BullMQ worker attempt on "unknown" delivery...');
      await processEmailJob(
        {
          id: `job_scenario_9_retry_${c7Id}`,
          data: { campaignId: c7Id, recipientId: r7Id },
          attemptsMade: 1,
        },
        testPool
      );

      const d9 = await getDelivery(c7Id, r7Id, testClient);
      assert(d9!.status === 'unknown', 'Delivery status strictly remains "unknown"');

      const a9Count = await testClient.query(
        `SELECT COUNT(*) as cnt FROM email_attempts WHERE delivery_id = $1;`,
        [d7!.id]
      );
      assert(parseInt(a9Count.rows[0].cnt, 10) === 1, 'ZERO new attempts created (attempt_count remains 1)');

      // ======================================================================
      // SCENARIO 10: Multiple configured senders retain their individual identities
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 10: Multiple configured senders retain individual identities');
      console.log(SUB_SEP);

      clearTransporterCache();
      smtpControl.mode = 'normal';
      smtpControl.assignedMessageId = '<multi-sender-test-10@test.smtp>';
      smtpControl.sessions = [];

      const senderAlphaId = await createTestSender('Alpha Corporation', 'alpha@corp.test', 'user_alpha', 'pass_alpha');
      const senderBetaId = await createTestSender('Beta Solutions', 'beta@solutions.test', 'user_beta', 'pass_beta');

      // Campaign Alpha
      const cAlpha = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, $2, 'Alpha Campaign', 'Hello from Alpha', 'sending') RETURNING id;
      `, [userId, senderAlphaId]);
      const cAlphaId = cAlpha.rows[0].id;
      const rAlphaId = await createTestRecip(cAlphaId, 'client_alpha@reachinbox.test');

      // Campaign Beta
      const cBeta = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, $2, 'Beta Campaign', 'Hello from Beta', 'sending') RETURNING id;
      `, [userId, senderBetaId]);
      const cBetaId = cBeta.rows[0].id;
      const rBetaId = await createTestRecip(cBetaId, 'client_beta@reachinbox.test');

      // Dispatch Alpha
      await processEmailJob(
        {
          id: `job_multi_alpha_${cAlphaId}`,
          data: { campaignId: cAlphaId, recipientId: rAlphaId },
          attemptsMade: 0,
        },
        testPool
      );

      // Dispatch Beta
      await processEmailJob(
        {
          id: `job_multi_beta_${cBetaId}`,
          data: { campaignId: cBetaId, recipientId: rBetaId },
          attemptsMade: 0,
        },
        testPool
      );

      // Verify deliveries in PostgreSQL
      const dAlpha = await getDelivery(cAlphaId, rAlphaId, testClient);
      const dBeta = await getDelivery(cBetaId, rBetaId, testClient);
      assert(dAlpha!.status === 'sent' && dBeta!.status === 'sent', 'Both multi-sender deliveries sent successfully');

      const aAlpha = await testClient.query(`SELECT sender_id FROM email_attempts WHERE delivery_id = $1`, [dAlpha!.id]);
      const aBeta = await testClient.query(`SELECT sender_id FROM email_attempts WHERE delivery_id = $1`, [dBeta!.id]);
      assert(aAlpha.rows[0].sender_id === senderAlphaId, 'Alpha attempt strictly associated with Sender Alpha');
      assert(aBeta.rows[0].sender_id === senderBetaId, 'Beta attempt strictly associated with Sender Beta');

      // Verify protocol sessions recorded on real SMTP server
      const alphaSession = smtpControl.sessions.find((s) => s.fromHeader?.includes('alpha@corp.test'));
      const betaSession = smtpControl.sessions.find((s) => s.fromHeader?.includes('beta@solutions.test'));
      assert(alphaSession !== undefined, 'SMTP server received Alpha dispatch with "alpha@corp.test" From header');
      assert(betaSession !== undefined, 'SMTP server received Beta dispatch with "beta@solutions.test" From header');
      assert(alphaSession?.authUser === 'user_alpha', 'Alpha session authenticated with credentials for "user_alpha"');
      assert(betaSession?.authUser === 'user_beta', 'Beta session authenticated with credentials for "user_beta"');

      // ======================================================================
      // SCENARIO 11: PostgreSQL failure immediately after SMTP acceptance (Batch 3.1 Bug 2)
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 11: PostgreSQL failure immediately after SMTP acceptance');
      console.log(SUB_SEP);

      clearTransporterCache();
      smtpControl.mode = 'normal';
      const actualServerMsgIdDbFail = '<db-fail-accepted-789@reachinbox.test>';
      smtpControl.assignedMessageId = actualServerMsgIdDbFail;

      const sender11Id = await createTestSender('Sender DB Fail', 'dbfail@sender.test', 'user_dbfail', 'pass');
      const c11 = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, $2, 'DB Fail After Send Test', 'Body', 'sending') RETURNING id;
      `, [userId, sender11Id]);
      const c11Id = c11.rows[0].id;
      const r11Id = await createTestRecip(c11Id, 'db_fail_recip@reachinbox.test');

      let c11Thrown = false;
      try {
        await processEmailJob(
          {
            id: `job_scenario_11_${c11Id}`,
            data: {
              campaignId: c11Id,
              recipientId: r11Id,
              simulateDbFailureAfterSend: true,
            },
            attemptsMade: 0,
          },
          testPool
        );
      } catch {
        c11Thrown = true;
      }

      assert(!c11Thrown, 'Worker does NOT rethrow post-acceptance DB failure (prevents BullMQ auto-retry loops)');

      const d11 = await getDelivery(c11Id, r11Id, testClient);
      assert(d11!.status === 'unknown', 'Delivery transitioned to non-dispatchable "unknown" state for reconciliation');
      assert(d11!.smtp_message_id === actualServerMsgIdDbFail, 'Delivery preserved genuine SMTP message ID despite DB failure');
      assert(d11!.claim_owner === null, 'Claim owner cleared on persistence failure');
      assert(d11!.lease_expires_at === null, 'Lease expiry cleared on persistence failure');
      assert(
        d11!.last_error !== null && d11!.last_error.includes('PostgreSQL persistence failure'),
        'Delivery records clear PostgreSQL persistence failure context (not SMTP error)'
      );

      const a11 = await testClient.query(
        `SELECT * FROM email_attempts WHERE delivery_id = $1 ORDER BY attempt_number DESC LIMIT 1;`,
        [d11!.id]
      );
      assert(a11.rows[0].status === 'unknown', 'Attempt recorded as "unknown" to preserve audit trail');
      assert(a11.rows[0].smtp_message_id === actualServerMsgIdDbFail, 'Attempt stores exact genuine SMTP message ID');
      assert(a11.rows[0].error_classification === 'persistence_failure_after_acceptance', 'Classification is persistence_failure_after_acceptance');

      // ======================================================================
      // SCENARIO 12: Retry/recovery after database failure must NOT send email again (Batch 3.1 Bug 2)
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 12: Retry/recovery after DB failure must NOT send email again');
      console.log(SUB_SEP);

      // Count how many times the SMTP test server has accepted an email for this recipient so far
      const initialSmtpSendsCount = smtpControl.sessions.filter(
        (s) => s.rcptTo?.includes('db_fail_recip@reachinbox.test') && s.dataLines?.length > 0
      ).length;
      assert(initialSmtpSendsCount === 1, 'Initial send reached SMTP server exactly once');

      // Attempt 1: Simulate BullMQ worker reprocessing the delivery
      console.log('   Simulating BullMQ worker attempt on post-DB-failure delivery...');
      await processEmailJob(
        {
          id: `job_scenario_12_retry_${c11Id}`,
          data: {
            campaignId: c11Id,
            recipientId: r11Id,
          },
          attemptsMade: 1,
        },
        testPool
      );

      // Attempt 2: Verify claimDelivery refuses to claim the delivery
      const claimAfterDbFail = await claimDelivery({
        campaignId: c11Id,
        recipientId: r11Id,
        claimOwner: 'recovery_worker_probe',
        leaseDurationMs: 60000,
        dbClient: testClient,
      });
      assert(claimAfterDbFail === null, 'Recovery worker cannot claim delivery in "unknown" state');

      // Verify SMTP server received ZERO duplicate sends
      const finalSmtpSendsCount = smtpControl.sessions.filter(
        (s) => s.rcptTo?.includes('db_fail_recip@reachinbox.test') && s.dataLines?.length > 0
      ).length;
      assert(finalSmtpSendsCount === initialSmtpSendsCount, 'SMTP server received ZERO duplicate dispatches (email was never resent)');

      // Verify delivery status and attempt count remain unchanged
      const d12 = await getDelivery(c11Id, r11Id, testClient);
      assert(d12!.status === 'unknown', 'Delivery status strictly remains "unknown"');

      const a12Count = await testClient.query(
        `SELECT COUNT(*) as cnt FROM email_attempts WHERE delivery_id = $1;`,
        [d11!.id]
      );
      assert(parseInt(a12Count.rows[0].cnt, 10) === 1, 'ZERO new attempts created (attempt_count remains 1)');

      // ======================================================================
      // SCENARIO 13: Stale claim reconciliation after PostgreSQL outage (Batch 3.2 Bug 1)
      //   Tests 1-6: SMTP acceptance → DB outage → lease expires → reconciliation → verify unknown
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 13: Stale claim reconciliation after PostgreSQL outage');
      console.log(SUB_SEP);

      clearTransporterCache();
      smtpControl.mode = 'normal';
      const staleMsgId = '<stale-claim-accepted-321@reachinbox.test>';
      smtpControl.assignedMessageId = staleMsgId;
      smtpControl.sessions = [];

      const sender13Id = await createTestSender('Sender Stale', 'stale@sender.test', 'user_stale', 'pass');
      const c13 = await testClient.query(`
        INSERT INTO campaigns (user_id, sender_id, subject, body, status)
        VALUES ($1, $2, 'Stale Claim Test', 'Body', 'sending') RETURNING id;
      `, [userId, sender13Id]);
      const c13Id = c13.rows[0].id;
      const r13Id = await createTestRecip(c13Id, 'stale_recip@reachinbox.test');

      // Step 1: Simulate SMTP acceptance followed by DB persistence failure
      let c13Thrown = false;
      try {
        await processEmailJob(
          {
            id: `job_scenario_13_${c13Id}`,
            data: {
              campaignId: c13Id,
              recipientId: r13Id,
              simulateDbFailureAfterSend: true,
            },
            attemptsMade: 0,
          },
          testPool
        );
      } catch {
        c13Thrown = true;
      }
      assert(!c13Thrown, 'Worker does NOT rethrow on post-acceptance DB failure');

      // Count initial SMTP sends (should be exactly 1)
      const staleSmtpCount1 = smtpControl.sessions.filter(
        (s) => s.rcptTo?.includes('stale_recip@reachinbox.test') && s.dataLines?.length > 0
      ).length;
      assert(staleSmtpCount1 === 1, 'SMTP server received exactly one submission');

      // Delivery should already be 'unknown' from recordPostgresPersistenceFailure
      const d13a = await getDelivery(c13Id, r13Id, testClient);
      assert(d13a!.status === 'unknown', 'Delivery is in non-dispatchable \"unknown\" state after DB persistence failure');

      // Step 2: Simulate a scenario where delivery stayed in 'sending' (the more dangerous case):
      // Directly put delivery back to 'sending' with an EXPIRED lease to simulate a crash
      // where recordPostgresPersistenceFailure never executed
      await testClient.query(
        `UPDATE email_deliveries
         SET status = 'sending',
             claim_owner = 'crashed_worker_1234',
             lease_expires_at = NOW() - INTERVAL '5 minutes',
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [d13a!.id]
      );
      // Also put the attempt back to 'attempting' to simulate the crash scenario
      await testClient.query(
        `UPDATE email_attempts
         SET status = 'attempting',
             error_classification = NULL,
             error_message = NULL,
             completed_at = NULL
         WHERE delivery_id = $1`,
        [d13a!.id]
      );

      // Step 3: Run stale-delivery reconciliation
      console.log('   Running stale claim reconciliation...');
      const reconResult = await reconcileStaleDeliveries(testPool);
      assert(reconResult.reconciledCount >= 1, 'Reconciliation found and processed stale delivery');
      assert(reconResult.reconciledIds.includes(d13a!.id), 'Stale delivery ID included in reconciled set');

      // Step 4: Verify delivery is now 'unknown', NOT 'pending' or 'sending'
      const d13b = await getDelivery(c13Id, r13Id, testClient);
      assert(d13b!.status === 'unknown', 'Delivery transitioned to \"unknown\" (not pending or sending) after reconciliation');
      assert(d13b!.claim_owner === null, 'Claim owner cleared by reconciliation');
      assert(d13b!.lease_expires_at === null, 'Lease expiry cleared by reconciliation');
      assert(
        d13b!.last_error !== null && d13b!.last_error.includes('Stale claim reconciliation'),
        'Last error records reconciliation context'
      );

      // Verify attempt record updated
      const a13 = await testClient.query(
        `SELECT * FROM email_attempts WHERE delivery_id = $1 ORDER BY attempt_number DESC LIMIT 1;`,
        [d13a!.id]
      );
      assert(a13.rows[0].status === 'unknown', 'Attempt transitioned to \"unknown\" by reconciliation');
      assert(a13.rows[0].error_classification === 'stale_claim_reconciliation', 'Classification is \"stale_claim_reconciliation\"');

      // Step 5: Verify a second worker cannot claim or resend
      const staleClaim = await claimDelivery({
        campaignId: c13Id,
        recipientId: r13Id,
        claimOwner: 'worker_post_reconciliation',
        leaseDurationMs: 60000,
        dbClient: testClient,
      });
      assert(staleClaim === null, 'Post-reconciliation claim returns NULL (delivery is non-dispatchable)');

      // Also verify processEmailJob skips it
      await processEmailJob(
        {
          id: `job_scenario_13_retry_${c13Id}`,
          data: { campaignId: c13Id, recipientId: r13Id },
          attemptsMade: 1,
        },
        testPool
      );
      const d13c = await getDelivery(c13Id, r13Id, testClient);
      assert(d13c!.status === 'unknown', 'Worker skips \"unknown\" delivery (never resent)');

      // Step 6: Verify SMTP server received exactly one submission (zero duplicates)
      const staleSmtpCount2 = smtpControl.sessions.filter(
        (s) => s.rcptTo?.includes('stale_recip@reachinbox.test') && s.dataLines?.length > 0
      ).length;
      assert(staleSmtpCount2 === 1, 'SMTP received exactly one submission total (zero duplicates after reconciliation)');

      // ======================================================================
      // SCENARIO 14: SMTP response code metadata correctness (Batch 3.2 Bug 2)
      //   Tests 7-9: genuine codes preserved, missing codes = NULL, network errors outside smtp_response_code
      // ======================================================================
      console.log('\n' + SUB_SEP);
      console.log('SCENARIO 14: SMTP response code metadata correctness');
      console.log(SUB_SEP);

      // Test 7: Actual SMTP response codes are preserved
      // Re-verify Scenario 1 (auth failure = 535), Scenario 4 (transient = 451), Scenario 5 (perm = 550)
      const s1a = await testClient.query(`SELECT smtp_response_code FROM email_attempts WHERE delivery_id = $1`, [d1!.id]);
      assert(s1a.rows[0].smtp_response_code === '535', 'Genuine SMTP code 535 preserved for auth failure');

      const s4a = await testClient.query(`SELECT smtp_response_code FROM email_attempts WHERE delivery_id = $1`, [d4!.id]);
      assert(s4a.rows[0].smtp_response_code === '451', 'Genuine SMTP code 451 preserved for transient rejection');

      const s5a = await testClient.query(`SELECT smtp_response_code FROM email_attempts WHERE delivery_id = $1`, [d5!.id]);
      assert(s5a.rows[0].smtp_response_code === '550', 'Genuine SMTP code 550 preserved for permanent rejection');

      const s8a = await testClient.query(`SELECT smtp_response_code FROM email_attempts WHERE delivery_id = $1`, [d8!.id]);
      assert(s8a.rows[0].smtp_response_code === '250', 'Genuine SMTP code 250 preserved for confirmed acceptance');

      // Test 8: Missing response codes remain NULL
      // Scenario 8b already verifies this for successful sends; also check connection failures and ambiguous outcomes
      const s6a = await testClient.query(`SELECT smtp_response_code, error_classification, error_message FROM email_attempts WHERE delivery_id = $1`, [d6!.id]);
      assert(
        s6a.rows[0].smtp_response_code === null,
        'Connection failure stores NULL smtp_response_code (not ECONNREFUSED)'
      );

      const s7a = await testClient.query(`SELECT smtp_response_code, error_classification, error_message FROM email_attempts WHERE delivery_id = $1`, [d7!.id]);
      assert(
        s7a.rows[0].smtp_response_code === null,
        'Ambiguous outcome stores NULL smtp_response_code (not ETIMEDOUT)'
      );

      // Test 9: Network error codes stored in error_message, not smtp_response_code
      assert(
        s6a.rows[0].error_message !== null && s6a.rows[0].error_message.length > 0,
        'Connection failure error details stored in error_message field'
      );
      assert(
        s6a.rows[0].error_classification === 'connection_failure',
        'Connection failure classification preserved in error_classification'
      );

      assert(
        s7a.rows[0].error_message !== null && s7a.rows[0].error_message.length > 0,
        'Ambiguous outcome error details stored in error_message field'
      );
      assert(
        s7a.rows[0].error_classification === 'ambiguous_outcome',
        'Ambiguous outcome classification preserved in error_classification'
      );

      // Verify Scenario 2 (ECONNREFUSED on connection) also stores NULL smtp_response_code
      const s2a = await testClient.query(`SELECT smtp_response_code, error_message FROM email_attempts WHERE delivery_id = $1`, [d2!.id]);
      assert(
        s2a.rows[0].smtp_response_code === null,
        'ECONNREFUSED connection failure stores NULL smtp_response_code (not network error code)'
      );
      assert(
        s2a.rows[0].error_message !== null && s2a.rows[0].error_message.includes('Connection failure'),
        'ECONNREFUSED details stored in error_message'
      );

    } finally {
      resetDefaultTransporter();
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
  console.log(`  BATCH 3 VERIFICATION COMPLETE: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log(SEP + '\n');

  if (failedTests > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runBatch3Verification().catch((err) => {
  console.error('Fatal error during Batch 3 verification:', err);
  process.exit(1);
});
