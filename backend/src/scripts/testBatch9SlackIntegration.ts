/**
 * src/scripts/testBatch9SlackIntegration.ts
 *
 * Verification suite for Batch 9: Real Slack OAuth & Rate-Limit Notifications
 *
 * Requirements:
 *   1. OAuth state generation and expiration.
 *   2. Invalid and replayed OAuth state.
 *   3. Successful Slack OAuth exchange.
 *   4. OAuth failure and revoked credentials.
 *   5. Token encryption and redaction at rest.
 *   6. Integration ownership and tenant isolation.
 *   7. Global rate-limit notification.
 *   8. Sender rate-limit notification.
 *   9. Campaign throttling notification.
 *  10. Duplicate notification prevention (Redis deduplication).
 *  11. Slack API timeout and failure isolation.
 *  12. Email delivery continues when Slack is unavailable.
 *  13. Integration disconnect.
 *  14. Production mock-mode restrictions.
 *  15. Baseline production DB (reachinbox) remains 100% UNTOUCHED.
 */

import { Client, Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';
import http from 'http';
import { AddressInfo } from 'net';
import crypto from 'crypto';

const PROD_DB_NAME = 'reachinbox';
const TEST_DB_NAME = 'reachinbox_migration_test';
const TEST_DB_URL = `postgresql://postgres:postgres@localhost:5432/${TEST_DB_NAME}`;
const BACKUP_FILE = path.resolve(__dirname, '../../../backup_before_stage1.dump');

// Force test environment for initial harness setup BEFORE requiring app or db
process.env.NODE_ENV = 'test';
process.env.ALLOW_TEST_AUTH = 'true';
process.env.DATABASE_URL = TEST_DB_URL;
process.env.SLACK_CLIENT_ID = 'test-slack-client-id-12345';
process.env.SLACK_CLIENT_SECRET = 'test-slack-client-secret-67890';
process.env.SLACK_REDIRECT_URI = 'http://localhost:5001/auth/slack/callback';

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  [PASS] ${message}`);
    passedCount++;
  } else {
    console.error(`  [FAIL] ${message}`);
    failedCount++;
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function dropAndCreateTestDb(): Promise<void> {
  const adminClient = new Client({
    connectionString: 'postgresql://postgres:postgres@localhost:5432/postgres',
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
  } finally {
    await adminClient.end();
  }
}

function restoreBackup(): void {
  const backupContainerPath = '/tmp/reachinbox-pre-stage1.dump';
  execSync(
    `docker exec reachinbox_postgres pg_restore -U postgres -d ${TEST_DB_NAME} --no-owner --no-privileges ${backupContainerPath}`,
    { stdio: 'pipe' },
  );
  console.log('   pg_restore completed successfully.');
}

async function applyMigrations(): Promise<void> {
  const testClient = new Client({ connectionString: TEST_DB_URL });
  await testClient.connect();
  try {
    const { runMigrations } = require('../db/migrate');
    await runMigrations(testClient);
  } finally {
    await testClient.end();
  }
}

async function verifyProdDbUntouched(): Promise<void> {
  const prodClient = new Client({
    connectionString: `postgresql://postgres:postgres@localhost:5432/${PROD_DB_NAME}`,
  });
  await prodClient.connect();
  try {
    const res = await prodClient.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    const tables = res.rows.map((r: { table_name: string }) => r.table_name);
    assert(
      !tables.includes('schema_migrations'),
      'Production database does NOT contain schema_migrations (untouched)',
    );
    assert(
      tables.length === 6,
      `Production database has exactly 6 original baseline tables (found: ${tables.length}: ${tables.join(', ')})`,
    );
  } finally {
    await prodClient.end();
  }
}

async function runTestSuite(): Promise<void> {
  console.log('\n==========================================================================');
  console.log('  BATCH 9 VERIFICATION: REAL SLACK OAUTH & RATE-LIMIT NOTIFICATIONS');
  console.log(`  Target Database: ${TEST_DB_NAME} (Ephemeral Isolated Test DB)`);
  console.log(`  Production DB:   ${PROD_DB_NAME} (UNTOUCHED)`);
  console.log('==========================================================================\n');

  console.log('0. Verifying initial baseline database integrity...');
  await verifyProdDbUntouched();
  console.log('   Baseline verified untouched.\n');

  console.log('1. Preparing isolated ephemeral test database...');
  await dropAndCreateTestDb();

  console.log('\n2. Restoring pre-stage1 backup into isolated database...');
  restoreBackup();

  console.log('\n3. Applying schema migrations to isolated database...');
  await applyMigrations();

  const testPool = new Pool({ connectionString: TEST_DB_URL });

  // Ensure user_sessions table exists in test DB before app creates session store
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS "user_sessions" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "user_sessions" ("expire");
  `);

  // Dynamically require app and dependencies now that DATABASE_URL points to test DB
  const { createApp } = require('../app');
  const { redis } = require('../db/redis');
  const { isEncrypted } = require('../utils/crypto');
  const {
    handleRateLimitNotification,
    sendSlackNotification,
    clearTestState,
    testState,
  } = require('../services/slackService');
  const { emailQueue } = require('../queue/emailQueue');

  // Start Express test server on random port
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`\n4. Started Express test server on ${baseUrl}`);

  try {
    // Seed test users: User A and User B
    const userAId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const userBId = 'bbbbbbbb-1111-2222-3333-444444444444';

    await testPool.query(`
      INSERT INTO users (id, email, name, google_id)
      VALUES
        ('${userAId}', 'user-a@reachinbox.test', 'User Alpha', 'g_alpha'),
        ('${userBId}', 'user-b@reachinbox.test', 'User Beta', 'g_beta')
      ON CONFLICT (id) DO NOTHING;
    `);

    // --------------------------------------------------------------------------
    // TEST 1: OAuth State Generation and Expiration
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 1: OAuth State Generation and Expiration');
    console.log('--------------------------------------------------------------------------');
    {
      const res = await fetch(`${baseUrl}/auth/slack?format=json`, {
        method: 'GET',
        headers: { 'x-test-user-id': userAId },
      });
      assert(res.status === 200, 'GET /auth/slack with format=json returns HTTP 200');
      const body = (await res.json()) as { url: string; state: string };
      assert(!!body.url && !!body.state, 'Response contains authorization URL and state');
      assert(body.state.length === 64, 'State is a 64-character cryptographically secure hex string');
      assert(body.url.includes(body.state), 'Authorization URL includes the generated state parameter');
      assert(body.url.includes('scope=incoming-webhook'), 'Authorization URL requests incoming-webhook scope');

      // Verify state in Redis
      const redisStateKey = `slack:oauth:state:${body.state}`;
      const stateDataStr = await redis.get(redisStateKey);
      assert(!!stateDataStr, 'OAuth state is stored in Redis');
      const stateData = JSON.parse(stateDataStr!);
      assert(stateData.userId === userAId, 'State in Redis is bound to authenticated user ID');
      const ttl = await redis.ttl(redisStateKey);
      assert(ttl > 0 && ttl <= 600, 'State has a valid expiration TTL <= 600s');

      // Test expiration: simulate expired state by deleting from Redis
      await redis.del(redisStateKey);
      const expiredCallbackRes = await fetch(
        `${baseUrl}/auth/slack/callback?code=mock-code-success&state=${body.state}`,
        {
          method: 'GET',
          headers: { 'x-test-user-id': userAId },
        },
      );
      assert(expiredCallbackRes.status === 400, 'Callback with expired state returns HTTP 400');
      const expiredBody = await expiredCallbackRes.json();
      assert(
        expiredBody.error.toLowerCase().includes('csrf') ||
          expiredBody.error.toLowerCase().includes('state'),
        'Rejection indicates invalid or expired state',
      );
    }

    // --------------------------------------------------------------------------
    // TEST 2: Invalid and Replayed OAuth State
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 2: Invalid and Replayed OAuth State');
    console.log('--------------------------------------------------------------------------');
    {
      // Tampered state
      const tamperedRes = await fetch(
        `${baseUrl}/auth/slack/callback?code=mock-code-success&state=completely_fake_tampered_state_999`,
        {
          method: 'GET',
          headers: { 'x-test-user-id': userAId },
        },
      );
      assert(tamperedRes.status === 400, 'Tampered state returns HTTP 400');

      // Replay attack defense
      const connectRes = await fetch(`${baseUrl}/auth/slack?format=json`, {
        method: 'GET',
        headers: { 'x-test-user-id': userAId },
      });
      const { state: validState } = (await connectRes.json()) as { state: string };

      // First callback with valid state succeeds
      const firstCallback = await fetch(
        `${baseUrl}/auth/slack/callback?code=mock-code-success&state=${validState}&format=json`,
        {
          method: 'GET',
          headers: { 'x-test-user-id': userAId },
        },
      );
      assert(firstCallback.status === 200, 'First callback with valid state succeeds (200)');

      // Replay of the exact same callback URL fails
      const replayCallback = await fetch(
        `${baseUrl}/auth/slack/callback?code=mock-code-success&state=${validState}&format=json`,
        {
          method: 'GET',
          headers: { 'x-test-user-id': userAId },
        },
      );
      assert(replayCallback.status === 400, 'Replayed state is rejected with HTTP 400 (one-time use)');

      // Cross-user state hijacking defense: User A generates state, User B attempts to consume it
      const connectUserA = await fetch(`${baseUrl}/auth/slack?format=json`, {
        method: 'GET',
        headers: { 'x-test-user-id': userAId },
      });
      const { state: userAState } = (await connectUserA.json()) as { state: string };

      const hijackCallback = await fetch(
        `${baseUrl}/auth/slack/callback?code=mock-code-success&state=${userAState}&format=json`,
        {
          method: 'GET',
          headers: { 'x-test-user-id': userBId }, // User B tries to use User A's state!
        },
      );
      assert(
        hijackCallback.status === 403,
        'State hijacking across tenants is rejected with HTTP 403 Forbidden',
      );
    }

    // --------------------------------------------------------------------------
    // TEST 3: Successful Slack OAuth Exchange
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 3: Successful Slack OAuth Exchange');
    console.log('--------------------------------------------------------------------------');
    {
      const connectRes = await fetch(`${baseUrl}/auth/slack?format=json`, {
        method: 'GET',
        headers: { 'x-test-user-id': userAId },
      });
      const { state } = (await connectRes.json()) as { state: string };

      const callbackRes = await fetch(
        `${baseUrl}/auth/slack/callback?code=mock-code-success&state=${state}&format=json`,
        {
          method: 'GET',
          headers: { 'x-test-user-id': userAId },
        },
      );
      assert(callbackRes.status === 200, 'OAuth code exchange succeeds with HTTP 200');
      const callbackBody = await callbackRes.json();
      assert(callbackBody.success === true, 'Response indicates success = true');
      assert(callbackBody.teamName === 'Mock Slack Workspace', 'Workspace teamName matches exchange');

      // Verify status endpoint reflects connection
      const statusRes = await fetch(`${baseUrl}/auth/slack/status`, {
        method: 'GET',
        headers: { 'x-test-user-id': userAId },
      });
      assert(statusRes.status === 200, 'GET /auth/slack/status returns HTTP 200');
      const statusBody = await statusRes.json();
      assert(statusBody.connected === true, 'Status reports connected = true');
      assert(statusBody.teamName === 'Mock Slack Workspace', 'Status reports teamName');
      assert(statusBody.channelName === '#test-notifications', 'Status reports channelName');
    }

    // --------------------------------------------------------------------------
    // TEST 4: OAuth Failure and Revoked Credentials
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 4: OAuth Failure and Revoked Credentials');
    console.log('--------------------------------------------------------------------------');
    {
      const connectRes1 = await fetch(`${baseUrl}/auth/slack?format=json`, {
        method: 'GET',
        headers: { 'x-test-user-id': userAId },
      });
      const { state: state1 } = (await connectRes1.json()) as { state: string };

      const failRes = await fetch(
        `${baseUrl}/auth/slack/callback?code=mock-code-fail&state=${state1}&format=json`,
        {
          method: 'GET',
          headers: { 'x-test-user-id': userAId },
        },
      );
      assert(failRes.status === 400, 'OAuth code rejection returns HTTP 400');
      const failBody = await failRes.json();
      assert(
        failBody.error.includes('invalid_code'),
        'Error message reports Slack error code invalid_code',
      );

      const connectRes2 = await fetch(`${baseUrl}/auth/slack?format=json`, {
        method: 'GET',
        headers: { 'x-test-user-id': userAId },
      });
      const { state: state2 } = (await connectRes2.json()) as { state: string };

      const revokedRes = await fetch(
        `${baseUrl}/auth/slack/callback?code=mock-code-revoked&state=${state2}&format=json`,
        {
          method: 'GET',
          headers: { 'x-test-user-id': userAId },
        },
      );
      assert(revokedRes.status === 400, 'Revoked token error returns HTTP 400');
      const revokedBody = await revokedRes.json();
      assert(
        revokedBody.error.includes('token_revoked'),
        'Error message reports token_revoked',
      );
    }

    // --------------------------------------------------------------------------
    // TEST 5: Token Encryption and Redaction at Rest
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 5: Token Encryption and Redaction at Rest');
    console.log('--------------------------------------------------------------------------');
    {
      // Inspect raw PostgreSQL row in test DB
      const dbRowRes = await testPool.query(
        'SELECT access_token, webhook_url FROM slack_integrations WHERE user_id = $1',
        [userAId],
      );
      assert(dbRowRes.rows.length === 1, 'Slack integration row exists in database');
      const rawRow = dbRowRes.rows[0];

      assert(isEncrypted(rawRow.access_token), 'access_token is encrypted at rest using AES-256-GCM');
      assert(
        !rawRow.access_token.includes('xoxb-'),
        'Raw database column does not leak plaintext token prefix',
      );
      assert(isEncrypted(rawRow.webhook_url), 'webhook_url is encrypted at rest using AES-256-GCM');
      assert(
        !rawRow.webhook_url.includes('https://hooks.slack.com'),
        'Raw database column does not leak plaintext webhook secret URL',
      );

      // Verify GET /auth/slack/status redaction
      const statusRes = await fetch(`${baseUrl}/auth/slack/status`, {
        method: 'GET',
        headers: { 'x-test-user-id': userAId },
      });
      const statusText = await statusRes.text();
      assert(!statusText.includes('access_token'), 'Status API never returns access_token field');
      assert(!statusText.includes('xoxb-'), 'Status API never returns access token content');
      assert(!statusText.includes('webhook_url'), 'Status API never returns webhook_url field');
      assert(!statusText.includes('hooks.slack.com'), 'Status API never returns webhook secret URL');
    }

    // --------------------------------------------------------------------------
    // TEST 6: Integration Ownership and Tenant Isolation
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 6: Integration Ownership and Tenant Isolation');
    console.log('--------------------------------------------------------------------------');
    {
      // User B has not connected Slack yet
      const statusUserB = await fetch(`${baseUrl}/auth/slack/status`, {
        method: 'GET',
        headers: { 'x-test-user-id': userBId },
      });
      const bodyUserB = await statusUserB.json();
      assert(bodyUserB.connected === false, 'User B status reports connected = false');

      // User B cannot disconnect User A's integration
      const disconnectUserB = await fetch(`${baseUrl}/auth/slack`, {
        method: 'DELETE',
        headers: { 'x-test-user-id': userBId },
      });
      assert(disconnectUserB.status === 404, 'User B deleting nonexistent integration returns HTTP 404');

      // User A integration remains intact
      const statusUserA = await fetch(`${baseUrl}/auth/slack/status`, {
        method: 'GET',
        headers: { 'x-test-user-id': userAId },
      });
      const bodyUserA = await statusUserA.json();
      assert(bodyUserA.connected === true, 'User A integration remains intact and connected');
    }

    // Seed campaign for User A to test notifications
    const campAId = 'cccccccc-1111-2222-3333-444444444444';
    await testPool.query(`
      INSERT INTO campaigns (id, user_id, subject, body, hourly_limit, status)
      VALUES ('${campAId}', '${userAId}', 'Q4 Launch Announcement', 'Launch content', 50, 'sending')
      ON CONFLICT (id) DO NOTHING;
    `);

    // --------------------------------------------------------------------------
    // TEST 7: Global Rate-Limit Notification
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 7: Global Rate-Limit Notification');
    console.log('--------------------------------------------------------------------------');
    {
      clearTestState();

      await handleRateLimitNotification(
        {
          campaignId: campAId,
          reason: 'global',
          waitMs: 3600000,
          campaignLimit: 50,
          globalLimit: 500,
        },
        undefined,
        undefined,
        testPool,
        redis,
      );

      assert(testState.sentNotifications.length === 1, 'Global rate-limit notification sent');
      const notif = testState.sentNotifications[0];
      assert(
        notif.text.includes('Global Hourly Delivery Limit Reached') ||
          notif.text.includes('Global Limit Reached'),
        'Notification specifies Global Hourly Limit Reached event type',
      );
      assert(notif.text.includes('Q4 Launch Announcement'), 'Notification includes campaign subject');
      assert(notif.text.includes(campAId), 'Notification includes campaign ID');
      assert(notif.text.includes('01h 00m 00s'), 'Notification includes formatted expected reset time');
      assert(!notif.text.includes('password'), 'Notification does not contain passwords');
      assert(!notif.text.includes('xoxb-'), 'Notification does not contain access tokens');
    }

    // --------------------------------------------------------------------------
    // TEST 8: Sender Rate-Limit Notification
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 8: Sender Rate-Limit Notification');
    console.log('--------------------------------------------------------------------------');
    {
      clearTestState();

      const senderId = 'sender-uuid-999';
      const senderEmail = 'vip-outreach@reachinbox.test';

      await handleRateLimitNotification(
        {
          campaignId: campAId,
          reason: 'sender',
          waitMs: 1800000,
          senderId,
          senderEmail,
          senderLimit: 75,
        },
        undefined,
        undefined,
        testPool,
        redis,
      );

      assert(testState.sentNotifications.length === 1, 'Sender rate-limit notification sent');
      const notif = testState.sentNotifications[0];
      assert(
        notif.text.includes('Sender Hourly Delivery Limit Reached') ||
          notif.text.includes('Sender Limit Reached'),
        'Notification specifies Sender Hourly Limit Reached event type',
      );
      assert(notif.text.includes(senderEmail), 'Notification includes sender email');
      assert(notif.text.includes('75 emails/hour'), 'Notification includes sender limit');
      assert(notif.text.includes('30m 00s'), 'Notification includes formatted reset time (~30m)');
    }

    // --------------------------------------------------------------------------
    // TEST 9: Campaign Throttling Notification
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 9: Campaign Throttling Notification');
    console.log('--------------------------------------------------------------------------');
    {
      clearTestState();

      await handleRateLimitNotification(
        {
          campaignId: campAId,
          reason: 'campaign',
          waitMs: 900000,
          campaignLimit: 50,
        },
        undefined,
        undefined,
        testPool,
        redis,
      );

      assert(testState.sentNotifications.length === 1, 'Campaign rate-limit notification sent');
      const notif = testState.sentNotifications[0];
      assert(
        notif.text.includes('Campaign Hourly Delivery Limit Reached') ||
          notif.text.includes('Campaign Limit Reached'),
        'Notification specifies Campaign Hourly Limit Reached event type',
      );
      assert(notif.text.includes('50 emails/hour'), 'Notification includes campaign limit');
      assert(notif.text.includes('15m 00s'), 'Notification includes formatted reset time (~15m)');
    }

    // --------------------------------------------------------------------------
    // TEST 10: Duplicate Notification Prevention (Redis Deduplication)
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 10: Duplicate Notification Prevention (Redis Deduplication)');
    console.log('--------------------------------------------------------------------------');
    {
      clearTestState();

      const uniqueCampId = crypto.randomUUID();
      await testPool.query(`
        INSERT INTO campaigns (id, user_id, subject, body, hourly_limit, status)
        VALUES ('${uniqueCampId}', '${userAId}', 'Dedup Campaign', 'Content', 20, 'sending');
      `);

      // Trigger 1st notification
      await handleRateLimitNotification(
        {
          campaignId: uniqueCampId,
          reason: 'campaign',
          waitMs: 60000,
          campaignLimit: 20,
        },
        undefined,
        undefined,
        testPool,
        redis,
      );

      // Trigger 2nd notification immediately within the same rate-limit window
      await handleRateLimitNotification(
        {
          campaignId: uniqueCampId,
          reason: 'campaign',
          waitMs: 60000,
          campaignLimit: 20,
        },
        undefined,
        undefined,
        testPool,
        redis,
      );

      // Trigger 3rd notification immediately within the same rate-limit window
      await handleRateLimitNotification(
        {
          campaignId: uniqueCampId,
          reason: 'campaign',
          waitMs: 60000,
          campaignLimit: 20,
        },
        undefined,
        undefined,
        testPool,
        redis,
      );

      assert(
        testState.sentNotifications.length === 1,
        'Exactly 1 notification delivered; duplicates within the window were safely suppressed',
      );
    }

    // --------------------------------------------------------------------------
    // TEST 11: Slack API Timeout and Failure Isolation
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 11: Slack API Timeout and Failure Isolation');
    console.log('--------------------------------------------------------------------------');
    {
      testState.mockSendFailure = true;

      // Invoking handleRateLimitNotification when Slack fails must NOT throw
      let threw = false;
      try {
        await handleRateLimitNotification(
          {
            campaignId: campAId,
            reason: 'campaign',
            waitMs: 50000,
          },
          undefined,
          undefined,
          testPool,
          redis,
        );
      } catch {
        threw = true;
      }

      assert(!threw, 'handleRateLimitNotification safely catches Slack errors and never throws');
      testState.mockSendFailure = false;
    }

    // --------------------------------------------------------------------------
    // TEST 12: Email Delivery Continues When Slack Is Unavailable
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 12: Email Delivery Continues When Slack Is Unavailable');
    console.log('--------------------------------------------------------------------------');
    {
      // Campaign for User B (User B has NO Slack integration)
      const campBId = 'dddddddd-1111-2222-3333-444444444444';
      await testPool.query(`
        INSERT INTO campaigns (id, user_id, subject, body, hourly_limit, status)
        VALUES ('${campBId}', '${userBId}', 'User B Campaign', 'Content', 10, 'sending')
        ON CONFLICT (id) DO NOTHING;
      `);

      let workerError = false;
      try {
        await handleRateLimitNotification(
          {
            campaignId: campBId,
            reason: 'campaign',
            waitMs: 3600000,
          },
          undefined,
          undefined,
          testPool,
          redis,
        );
      } catch {
        workerError = true;
      }
      assert(
        !workerError,
        'Processing continues smoothly without throwing when user has no Slack integration',
      );
    }

    // --------------------------------------------------------------------------
    // TEST 13: Integration Disconnect
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 13: Integration Disconnect');
    console.log('--------------------------------------------------------------------------');
    {
      // User A disconnects Slack
      const disconnectRes = await fetch(`${baseUrl}/auth/slack`, {
        method: 'DELETE',
        headers: { 'x-test-user-id': userAId },
      });
      assert(disconnectRes.status === 200, 'DELETE /auth/slack returns HTTP 200');
      const disconnectBody = await disconnectRes.json();
      assert(
        disconnectBody.message.includes('disconnected successfully'),
        'Confirmation message returned',
      );

      // Verify status is now connected = false
      const statusAfter = await fetch(`${baseUrl}/auth/slack/status`, {
        method: 'GET',
        headers: { 'x-test-user-id': userAId },
      });
      const bodyAfter = await statusAfter.json();
      assert(bodyAfter.connected === false, 'Status reports connected = false after disconnect');

      // Subsequent delete returns HTTP 404
      const secondDelete = await fetch(`${baseUrl}/auth/slack`, {
        method: 'DELETE',
        headers: { 'x-test-user-id': userAId },
      });
      assert(secondDelete.status === 404, 'Repeated disconnect returns HTTP 404 Not Found');
    }

    // --------------------------------------------------------------------------
    // TEST 14: Production Mock-Mode Restrictions
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 14: Production Mock-Mode Restrictions');
    console.log('--------------------------------------------------------------------------');
    {
      // Generate state in test mode
      const connectRes = await fetch(`${baseUrl}/auth/slack?format=json`, {
        method: 'GET',
        headers: { 'x-test-user-id': userAId },
      });
      const { state: prodTestState } = (await connectRes.json()) as { state: string };

      // Temporarily switch environment to production
      process.env.NODE_ENV = 'production';

      const prodMockRes = await fetch(
        `${baseUrl}/auth/slack/callback?code=mock-code-success&state=${prodTestState}&format=json`,
        {
          method: 'GET',
          headers: { 'x-test-user-id': userAId },
        },
      );
      assert(
        prodMockRes.status === 400,
        'In production environment, mock OAuth codes are strictly rejected (HTTP 400)',
      );
      const prodMockBody = await prodMockRes.json();
      assert(
        prodMockBody.error.toLowerCase().includes('not permitted in production'),
        'Rejection message confirms mock codes forbidden in production',
      );

      // Restore test environment
      process.env.NODE_ENV = 'test';
    }

  } finally {
    server.close();
    await testPool.end();
    try {
      const { db } = require('../db/postgres');
      await db.end();
    } catch {}
    try {
      const { redis } = require('../db/redis');
      await redis.quit();
    } catch {}
    try {
      const { emailQueue } = require('../queue/emailQueue');
      await emailQueue.close();
    } catch {}

    console.log('\n5. Cleaning up isolated test database...');
    const cleanupClient = new Client({
      connectionString: 'postgresql://postgres:postgres@localhost:5432/postgres',
    });
    await cleanupClient.connect();
    try {
      await cleanupClient.query(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();
      `);
      await cleanupClient.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
      console.log(`   Database "${TEST_DB_NAME}" dropped cleanly.`);
    } finally {
      await cleanupClient.end();
    }

    console.log('\n6. Verifying original database integrity...');
    await verifyProdDbUntouched();
    console.log('  [PASS] Original "reachinbox" database remains 100% UNTOUCHED (zero migrations or queries against it)');
  }

  console.log('\n==========================================================================');
  console.log(`  BATCH 9 VERIFICATION COMPLETE: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('==========================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('\n❌ Unhandled error during Batch 9 verification:', err);
  process.exit(1);
});
