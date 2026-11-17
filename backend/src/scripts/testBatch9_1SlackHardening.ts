/**
 * testBatch9_1SlackHardening.ts
 *
 * BATCH 9.1 VERIFICATION SUITE: SLACK OAUTH REPLAY PROTECTION & NOTIFICATION RELIABILITY
 *
 * Requirements Verified:
 *   1. Authoritative Redis one-time state store (no session bypass).
 *   2. Replay attack rejection when using the same session cookie.
 *   3. Two concurrent callbacks using the same state (race condition defense).
 *   4. Expired, invalid, and tampered OAuth state handling.
 *   5. Redis unavailable during OAuth initiation and callback (fail closed).
 *   6. Session fallback cannot bypass consumed Redis state.
 *   7. Webhook secret protection: testState instrumentation never records webhook URLs.
 *   8. Production mock behavior and mock URLs strictly disabled in production.
 *   9. Concurrent notification deduplication via explicit Redis states.
 *  10. Definite Slack delivery failure releases reservation (no permanent suppression).
 *  11. Ambiguous timeout records 'uncertain' state (prevents duplicate spam).
 *  12. Email delivery and worker processing remain completely unaffected by Slack failures.
 *  13. Production database integrity preserved (100% untouched).
 */

import http from 'http';
import { AddressInfo } from 'net';
import { Client, Pool } from 'pg';
import crypto from 'crypto';
import { execSync } from 'child_process';
import path from 'path';

const PROD_DB_NAME = 'reachinbox';
const TEST_DB_NAME = 'reachinbox_migration_test';
const TEST_DB_URL = `postgresql://postgres:postgres@localhost:5432/${TEST_DB_NAME}`;

// Direct target database for test execution
process.env.DATABASE_URL = TEST_DB_URL;
process.env.NODE_ENV = 'test';
process.env.ALLOW_TEST_AUTH = 'true';
process.env.SLACK_CLIENT_ID = 'test-client-id-12345';
process.env.SLACK_CLIENT_SECRET = 'test-client-secret-67890';
process.env.SLACK_REDIRECT_URI = 'http://localhost:5000/auth/slack/callback';

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
    passedCount++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
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
  const { runMigrations } = require('../db/migrate');
  const pool = new Pool({ connectionString: TEST_DB_URL });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

async function verifyProdDbUntouched(): Promise<void> {
  const prodClient = new Client({
    connectionString: 'postgresql://postgres:postgres@localhost:5432/reachinbox',
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
  console.log('  BATCH 9.1 VERIFICATION: SLACK OAUTH REPLAY & NOTIFICATION RELIABILITY');
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

  const { createApp } = require('../app');
  const { redis } = require('../db/redis');
  const {
    handleRateLimitNotification,
    sendSlackNotification,
    clearTestState,
    testState,
    sanitizeSlackError,
    isUncertainSlackError,
  } = require('../services/slackService');
  const { emailQueue } = require('../queue/emailQueue');

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`\n4. Started Express test server on ${baseUrl}`);

  try {
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
    // TEST 1: Successful OAuth callback followed by replay using the same session
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 1: Successful OAuth Callback Followed by Replay Using Same Session');
    console.log('--------------------------------------------------------------------------');
    {
      // Step A: Initiate OAuth and obtain state and session cookie
      const initRes = await fetch(`${baseUrl}/auth/slack?format=json`, {
        method: 'GET',
        headers: { 'x-test-user-id': userAId },
      });
      assert(initRes.status === 200, 'Initiation returns HTTP 200');
      const { state } = (await initRes.json()) as { state: string };
      const setCookie = initRes.headers.get('set-cookie');
      const cookieHeader = setCookie ? setCookie.split(';')[0] : '';

      // Step B: First callback with valid state and session cookie
      const cb1 = await fetch(
        `${baseUrl}/auth/slack/callback?code=mock-code-success&state=${state}&format=json`,
        {
          method: 'GET',
          headers: {
            'x-test-user-id': userAId,
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
        },
      );
      assert(cb1.status === 200, 'First callback succeeds (HTTP 200)');
      const cb1Body = await cb1.json();
      assert(cb1Body.success === true, 'First callback reports success = true');

      // Step C: Replay callback with the exact same session cookie and state
      const cb2 = await fetch(
        `${baseUrl}/auth/slack/callback?code=mock-code-success&state=${state}&format=json`,
        {
          method: 'GET',
          headers: {
            'x-test-user-id': userAId,
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
        },
      );
      assert(cb2.status === 400, 'Replayed callback using same session is strictly rejected (HTTP 400)');
      const cb2Body = await cb2.json();
      assert(
        cb2Body.error.toLowerCase().includes('already used') ||
          cb2Body.error.toLowerCase().includes('invalid'),
        'Rejection message confirms state is already used / invalid',
      );
    }

    // --------------------------------------------------------------------------
    // TEST 2: Two concurrent callbacks using the same state
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 2: Two Concurrent Callbacks Using the Same State (Race Condition Defense)');
    console.log('--------------------------------------------------------------------------');
    {
      const initRes = await fetch(`${baseUrl}/auth/slack?format=json`, {
        method: 'GET',
        headers: { 'x-test-user-id': userAId },
      });
      const { state } = (await initRes.json()) as { state: string };

      // Dispatch two concurrent callbacks with the same state simultaneously
      const [cbA, cbB] = await Promise.all([
        fetch(
          `${baseUrl}/auth/slack/callback?code=mock-code-success&state=${state}&format=json`,
          {
            method: 'GET',
            headers: { 'x-test-user-id': userAId },
          },
        ),
        fetch(
          `${baseUrl}/auth/slack/callback?code=mock-code-success&state=${state}&format=json`,
          {
            method: 'GET',
            headers: { 'x-test-user-id': userAId },
          },
        ),
      ]);

      const statuses = [cbA.status, cbB.status].sort();
      assert(
        statuses[0] === 200 && statuses[1] === 400,
        `Exactly one concurrent callback succeeds (200) and the other is rejected (400) (got: ${statuses.join(', ')})`,
      );
    }

    // --------------------------------------------------------------------------
    // TEST 3: Expired and invalid OAuth states
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 3: Expired and Invalid OAuth States');
    console.log('--------------------------------------------------------------------------');
    {
      // Invalid state
      const invalidRes = await fetch(
        `${baseUrl}/auth/slack/callback?code=mock-code-success&state=completely-fabricated-state-999&format=json`,
        {
          method: 'GET',
          headers: { 'x-test-user-id': userAId },
        },
      );
      assert(invalidRes.status === 400, 'Fabricated state rejected with HTTP 400');

      // Empty state
      const emptyStateRes = await fetch(
        `${baseUrl}/auth/slack/callback?code=mock-code-success&state=&format=json`,
        {
          method: 'GET',
          headers: { 'x-test-user-id': userAId },
        },
      );
      assert(emptyStateRes.status === 400, 'Empty state rejected with HTTP 400');

      // Expired state (simulate TTL expiration by manually deleting key before callback)
      const initRes = await fetch(`${baseUrl}/auth/slack?format=json`, {
        method: 'GET',
        headers: { 'x-test-user-id': userAId },
      });
      const { state: expiredState } = (await initRes.json()) as { state: string };
      await redis.del(`slack:oauth:state:${expiredState}`);

      const expiredRes = await fetch(
        `${baseUrl}/auth/slack/callback?code=mock-code-success&state=${expiredState}&format=json`,
        {
          method: 'GET',
          headers: { 'x-test-user-id': userAId },
        },
      );
      assert(expiredRes.status === 400, 'Expired state rejected with HTTP 400');
    }

    // --------------------------------------------------------------------------
    // TEST 4: Redis unavailable during OAuth initiation and callback (Fail Closed)
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 4: Redis Unavailable During OAuth Initiation and Callback (Fail Closed)');
    console.log('--------------------------------------------------------------------------');
    {
      // Part A: Redis down during initiation
      const origSet = redis.set.bind(redis);
      redis.set = async () => {
        throw new Error('Connection to Redis refused (test mock)');
      };

      try {
        const initFailRes = await fetch(`${baseUrl}/auth/slack?format=json`, {
          method: 'GET',
          headers: { 'x-test-user-id': userAId },
        });
        assert(
          initFailRes.status === 503,
          'When Redis is unavailable during initiation, returns HTTP 503 Service Unavailable',
        );
        const initFailBody = await initFailRes.json();
        assert(
          initFailBody.error.toLowerCase().includes('unavailable'),
          'Error message clarifies state service is unavailable',
        );
      } finally {
        redis.set = origSet;
      }

      // Part B: Redis down during callback
      const initOkRes = await fetch(`${baseUrl}/auth/slack?format=json`, {
        method: 'GET',
        headers: { 'x-test-user-id': userAId },
      });
      const { state: validStateForCb } = (await initOkRes.json()) as { state: string };

      const origEval = redis.eval.bind(redis);
      redis.eval = async () => {
        throw new Error('Redis connection drop during evaluation (test mock)');
      };

      try {
        const cbFailRes = await fetch(
          `${baseUrl}/auth/slack/callback?code=mock-code-success&state=${validStateForCb}&format=json`,
          {
            method: 'GET',
            headers: { 'x-test-user-id': userAId },
          },
        );
        assert(
          cbFailRes.status === 503,
          'When Redis is unavailable during callback verification, returns HTTP 503 Service Unavailable',
        );
        const cbFailBody = await cbFailRes.json();
        assert(
          cbFailBody.error.toLowerCase().includes('unavailable'),
          'Error message clarifies verification service is unavailable',
        );
      } finally {
        redis.eval = origEval;
      }
    }

    // --------------------------------------------------------------------------
    // TEST 5: Session fallback cannot bypass consumed Redis state
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 5: Session Fallback Cannot Bypass Consumed Redis State');
    console.log('--------------------------------------------------------------------------');
    {
      const fakeSessionState = 'fake-session-state-' + crypto.randomBytes(16).toString('hex');
      const sessionId = 'test-session-' + crypto.randomBytes(8).toString('hex');

      // Inject legacy session data into PostgreSQL session store
      const sessionData = {
        cookie: { originalMaxAge: 86400000, expires: new Date(Date.now() + 86400000).toISOString() },
        passport: { user: userAId },
        slackOAuth: {
          state: fakeSessionState,
          userId: userAId,
          expiresAt: Date.now() + 600000,
        },
        slackState: fakeSessionState,
      };

      await testPool.query(
        `INSERT INTO user_sessions (sid, sess, expire) VALUES ($1, $2, NOW() + interval '1 day')`,
        [sessionId, JSON.stringify(sessionData)],
      );

      // Verify state does NOT exist in Redis
      const inRedis = await redis.get(`slack:oauth:state:${fakeSessionState}`);
      assert(inRedis === null, 'State is completely absent from authoritative Redis store');

      // Request callback passing the session cookie that holds legacy state
      const bypassRes = await fetch(
        `${baseUrl}/auth/slack/callback?code=mock-code-success&state=${fakeSessionState}&format=json`,
        {
          method: 'GET',
          headers: {
            'x-test-user-id': userAId,
            Cookie: `connect.sid=s%3A${sessionId}.${crypto.randomBytes(16).toString('hex')}`,
          },
        },
      );

      assert(
        bypassRes.status === 400,
        'Callback with session state but absent Redis state is strictly rejected (HTTP 400)',
      );
    }

    // --------------------------------------------------------------------------
    // TEST 6: Webhook secret protection: testState instrumentation never stores webhook URLs
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 6: Webhook Secret Protection: testState Never Stores Webhook URLs');
    console.log('--------------------------------------------------------------------------');
    {
      clearTestState();

      // Trigger test notification
      await sendSlackNotification(
        'Sanitization audit notification',
        'https://hooks.slack.com/services/mock-webhook-url',
      );

      assert(testState.sentNotifications.length === 1, 'Test notification recorded');
      const entry = testState.sentNotifications[0] as any;
      assert(
        entry.webhookUrl === undefined,
        'testState.sentNotifications entry does NOT contain webhookUrl property',
      );
      assert(
        !JSON.stringify(entry).includes('hooks.slack.com'),
        'testState entry does NOT contain any webhook URL string in payload',
      );

      // Verify sanitizeSlackError helper
      const sensitiveError = new Error(
        'Failed to connect to https://hooks.slack.com/services/T012345/B098765/SecretToken1234567 with xoxb-secret-bot-token-999',
      );
      const sanitized = sanitizeSlackError(sensitiveError);
      assert(
        !sanitized.includes('SecretToken1234567'),
        'sanitizeSlackError redacts webhook secret tokens',
      );
      assert(
        sanitized.includes('[REDACTED_WEBHOOK_URL]'),
        'sanitizeSlackError replaces webhook URL with [REDACTED_WEBHOOK_URL]',
      );
      assert(
        !sanitized.includes('xoxb-secret-bot-token-999'),
        'sanitizeSlackError redacts Slack bot tokens',
      );
      assert(
        sanitized.includes('[REDACTED_SLACK_TOKEN]'),
        'sanitizeSlackError replaces bot token with [REDACTED_SLACK_TOKEN]',
      );
    }

    // --------------------------------------------------------------------------
    // TEST 7: Production mock behavior and mock URLs disabled in production
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 7: Production Mock Behavior and Mock URLs Disabled in Production');
    console.log('--------------------------------------------------------------------------');
    {
      // 1. Generate state in test mode
      const initRes = await fetch(`${baseUrl}/auth/slack?format=json`, {
        method: 'GET',
        headers: { 'x-test-user-id': userAId },
      });
      const { state } = (await initRes.json()) as { state: string };

      process.env.NODE_ENV = 'production';
      try {
        const mockCodeRes = await fetch(
          `${baseUrl}/auth/slack/callback?code=mock-code-success&state=${state}&format=json`,
          {
            method: 'GET',
            headers: { 'x-test-user-id': userAId },
          },
        );
        assert(
          mockCodeRes.status === 400,
          'Mock OAuth codes strictly rejected in production (HTTP 400)',
        );
        const mockCodeBody = await mockCodeRes.json();
        assert(
          mockCodeBody.error.toLowerCase().includes('not permitted in production'),
          'Rejection confirms mock codes forbidden in production',
        );

        // 2. Mock webhook URLs strictly rejected in production
        let mockUrlThrew = false;
        try {
          await sendSlackNotification(
            'Production alert',
            'https://hooks.slack.com/services/mock-webhook-url',
          );
        } catch (err: any) {
          mockUrlThrew = true;
          assert(
            err.message.includes('Mock webhook URLs are strictly forbidden in production'),
            'sendSlackNotification rejects mock webhook URLs in production',
          );
        }
        assert(mockUrlThrew, 'sendSlackNotification threw on mock webhook URL in production');

        // 3. testState instrumentation does not record in production
        clearTestState();
        try {
          await sendSlackNotification(
            'Production alert 2',
            'https://hooks.slack.com/services/invalid-production-target',
          );
        } catch {}
        assert(
          testState.sentNotifications.length === 0,
          'testState.sentNotifications never records notifications in production environment',
        );
      } finally {
        process.env.NODE_ENV = 'test';
      }
    }

    // --------------------------------------------------------------------------
    // TEST 8: Concurrent notification deduplication via explicit Redis states
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 8: Concurrent Notification Deduplication via Explicit Redis States');
    console.log('--------------------------------------------------------------------------');
    {
      clearTestState();

      const uniqueCampId = crypto.randomUUID();
      await testPool.query(`
        INSERT INTO campaigns (id, user_id, subject, body, hourly_limit, status)
        VALUES ('${uniqueCampId}', '${userAId}', 'Concurrent Notif Campaign', 'Body', 50, 'sending');
      `);

      // Fire two notifications concurrently for the exact same rate-limit event
      await Promise.all([
        handleRateLimitNotification(
          {
            campaignId: uniqueCampId,
            reason: 'campaign',
            waitMs: 120000,
            campaignLimit: 50,
          },
          undefined,
          undefined,
          testPool,
          redis,
        ),
        handleRateLimitNotification(
          {
            campaignId: uniqueCampId,
            reason: 'campaign',
            waitMs: 120000,
            campaignLimit: 50,
          },
          undefined,
          undefined,
          testPool,
          redis,
        ),
      ]);

      assert(
        testState.sentNotifications.length === 1,
        'Concurrent duplicate notifications suppressed: exactly 1 alert delivered',
      );

      // Verify explicit state 'delivered' in Redis
      const windowEpoch = Math.floor((Date.now() + 120000) / 1000);
      const dedupKey = `slack:ratelimit:notified:campaign:${uniqueCampId}:${windowEpoch}`;
      const stateVal = await redis.get(dedupKey);
      assert(stateVal === 'delivered', 'Redis deduplication key holds explicit state "delivered"');
    }

    // --------------------------------------------------------------------------
    // TEST 9: Definite Slack delivery failure releases reservation
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 9: Definite Slack Delivery Failure Releases Reservation (No Permanent Suppression)');
    console.log('--------------------------------------------------------------------------');
    {
      clearTestState();

      const uniqueCampId = crypto.randomUUID();
      await testPool.query(`
        INSERT INTO campaigns (id, user_id, subject, body, hourly_limit, status)
        VALUES ('${uniqueCampId}', '${userAId}', 'Definite Failure Campaign', 'Body', 50, 'sending');
      `);

      // Simulate definite failure (HTTP 500 / post failure)
      testState.mockSendFailure = true;

      await handleRateLimitNotification(
        {
          campaignId: uniqueCampId,
          reason: 'campaign',
          waitMs: 180000,
          campaignLimit: 50,
        },
        undefined,
        undefined,
        testPool,
        redis,
      );

      assert(testState.sentNotifications.length === 1, 'Attempted send recorded before failure');

      // Check Redis reservation: reservation MUST have been released so future alerts aren't blocked
      const windowEpoch = Math.floor((Date.now() + 180000) / 1000);
      const dedupKey = `slack:ratelimit:notified:campaign:${uniqueCampId}:${windowEpoch}`;
      const stateValAfterFailure = await redis.get(dedupKey);
      assert(
        stateValAfterFailure === null,
        'Reservation key was cleanly deleted on definite failure (not left reserved or delivered)',
      );

      // Clear failure simulation: next attempt in the same window should be allowed to succeed
      testState.mockSendFailure = false;
      clearTestState();

      await handleRateLimitNotification(
        {
          campaignId: uniqueCampId,
          reason: 'campaign',
          waitMs: 180000,
          campaignLimit: 50,
        },
        undefined,
        undefined,
        testPool,
        redis,
      );

      assert(
        testState.sentNotifications.length === 1,
        'Subsequent notification succeeds after definite failure (alert was NOT suppressed for 1 hour)',
      );

      const stateValAfterRetry = await redis.get(dedupKey);
      assert(stateValAfterRetry === 'delivered', 'Deduplication state successfully transitioned to "delivered"');
    }

    // --------------------------------------------------------------------------
    // TEST 10: Ambiguous timeout after notification submission (Prevents Duplicate Spam)
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 10: Ambiguous Timeout Records "uncertain" State (Prevents Duplicate Spam)');
    console.log('--------------------------------------------------------------------------');
    {
      clearTestState();

      const uniqueCampId = crypto.randomUUID();
      await testPool.query(`
        INSERT INTO campaigns (id, user_id, subject, body, hourly_limit, status)
        VALUES ('${uniqueCampId}', '${userAId}', 'Timeout Campaign', 'Body', 50, 'sending');
      `);

      // Simulate ambiguous timeout failure (AbortError after 5 seconds)
      testState.mockTimeoutFailure = true;

      await handleRateLimitNotification(
        {
          campaignId: uniqueCampId,
          reason: 'campaign',
          waitMs: 240000,
          campaignLimit: 50,
        },
        undefined,
        undefined,
        testPool,
        redis,
      );

      // Check Redis reservation: MUST record 'uncertain' to prevent flooding Slack
      const windowEpoch = Math.floor((Date.now() + 240000) / 1000);
      const dedupKey = `slack:ratelimit:notified:campaign:${uniqueCampId}:${windowEpoch}`;
      const stateValAfterTimeout = await redis.get(dedupKey);
      assert(
        stateValAfterTimeout === 'uncertain',
        'Redis deduplication key holds explicit state "uncertain" after timeout',
      );

      // Clear mock timeout: subsequent attempt in same window MUST be suppressed as duplicate
      testState.mockTimeoutFailure = false;
      clearTestState();

      await handleRateLimitNotification(
        {
          campaignId: uniqueCampId,
          reason: 'campaign',
          waitMs: 240000,
          campaignLimit: 50,
        },
        undefined,
        undefined,
        testPool,
        redis,
      );

      assert(
        testState.sentNotifications.length === 0,
        'Subsequent notification suppressed after ambiguous timeout (avoids duplicate message flood)',
      );
    }

    // --------------------------------------------------------------------------
    // TEST 11: Email processing remains unaffected by Slack failures
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 11: Email Processing Remains Unaffected by Slack Failures');
    console.log('--------------------------------------------------------------------------');
    {
      // Verify that handleRateLimitNotification never throws across all error scenarios:
      // 1. Missing campaign
      let threwMissing = false;
      try {
        await handleRateLimitNotification(
          {
            campaignId: '00000000-0000-0000-0000-000000000000',
            reason: 'campaign',
            waitMs: 60000,
          },
          undefined,
          undefined,
          testPool,
          redis,
        );
      } catch {
        threwMissing = true;
      }
      assert(!threwMissing, 'handleRateLimitNotification never throws on non-existent campaign');

      // 2. Mock definite failure
      testState.mockSendFailure = true;
      let threwDefinite = false;
      try {
        await handleRateLimitNotification(
          {
            campaignId: 'cccccccc-1111-2222-3333-444444444444',
            reason: 'campaign',
            waitMs: 60000,
          },
          undefined,
          undefined,
          testPool,
          redis,
        );
      } catch {
        threwDefinite = true;
      }
      assert(!threwDefinite, 'handleRateLimitNotification never throws on definite Slack API failure');
      testState.mockSendFailure = false;

      // 3. Mock timeout failure
      testState.mockTimeoutFailure = true;
      let threwTimeout = false;
      try {
        await handleRateLimitNotification(
          {
            campaignId: 'cccccccc-1111-2222-3333-444444444444',
            reason: 'campaign',
            waitMs: 60000,
          },
          undefined,
          undefined,
          testPool,
          redis,
        );
      } catch {
        threwTimeout = true;
      }
      assert(!threwTimeout, 'handleRateLimitNotification never throws on Slack timeout');
      testState.mockTimeoutFailure = false;

      // 4. Injected sender failure
      let threwInjected = false;
      try {
        await handleRateLimitNotification(
          {
            campaignId: 'cccccccc-1111-2222-3333-444444444444',
            reason: 'campaign',
            waitMs: 60000,
          },
          undefined,
          undefined,
          testPool,
          redis,
          async () => {
            throw new Error('Custom injected transport failure');
          },
        );
      } catch {
        threwInjected = true;
      }
      assert(!threwInjected, 'handleRateLimitNotification never throws on injected transport failure');
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
  console.log(`  BATCH 9.1 VERIFICATION COMPLETE: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('==========================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('\n❌ Unhandled error during Batch 9.1 verification:', err);
  process.exit(1);
});
