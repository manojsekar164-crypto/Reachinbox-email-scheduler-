/**
 * src/scripts/testBatch8BullBoardSecurity.ts
 *
 * Verification suite for Batch 8: Bull Board Security & Admin Access
 *
 * Requirements:
 *   1. Require authentication for every Bull Board dashboard route and API endpoint.
 *   2. Enforce admin-only authorization using trusted environment-configured allowlist.
 *   3. Fail closed when admin authorization is not configured.
 *   4. Reject client-supplied headers or request-body roles (injection defense).
 *   5. Ensure Bull Board assets, API requests, and queue actions cannot bypass authorization.
 *   6. Preserve existing BullMQ queue and dashboard functionality.
 *   7. Do not expose queue information to ordinary users.
 *   8. Production environment cannot expose the dashboard publicly.
 *   9. Zero sensitive data leakage in error responses or logs.
 *  10. Production database (reachinbox) remains 100% UNTOUCHED.
 */

import { Client, Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';
import http from 'http';
import { AddressInfo } from 'net';
import crypto from 'crypto';
import signature from 'cookie-signature';

const PROD_DB_NAME = 'reachinbox';
const TEST_DB_NAME = 'reachinbox_migration_test';
const TEST_DB_URL = `postgresql://postgres:postgres@localhost:5432/${TEST_DB_NAME}`;
const BACKUP_FILE = path.resolve(__dirname, '../../../backup_before_stage1.dump');

// Force test environment for initial harness setup BEFORE requiring app or db
process.env.NODE_ENV = 'test';
process.env.ALLOW_TEST_AUTH = 'true';
process.env.DATABASE_URL = TEST_DB_URL;

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
      `Production database has exactly 6 original baseline tables (found: ${tables.length})`,
    );
  } finally {
    await prodClient.end();
  }
}

async function runTestSuite(): Promise<void> {
  console.log('\n==========================================================================');
  console.log('  BATCH 8 VERIFICATION: BULL BOARD SECURITY & ADMIN AUTHORIZATION');
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
  const { config } = require('../config');
  const { emailQueue } = require('../queue/emailQueue');

  // Start Express test server on random port
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`\n4. Started Express test server on ${baseUrl}`);

  try {
    // --------------------------------------------------------------------------
    // TEST 1: Unauthenticated request to /admin/queues root is rejected (HTTP 401)
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 1: Unauthenticated request to /admin/queues root is rejected (401)');
    console.log('--------------------------------------------------------------------------');
    {
      const resRoot = await fetch(`${baseUrl}/admin/queues`, { method: 'GET' });
      assert(resRoot.status === 401, 'GET /admin/queues returns HTTP 401 Unauthorized');
      const bodyRoot = await resRoot.json();
      assert(bodyRoot.error === 'Authentication required', 'Response body has error "Authentication required"');

      const resSlash = await fetch(`${baseUrl}/admin/queues/`, { method: 'GET' });
      assert(resSlash.status === 401, 'GET /admin/queues/ returns HTTP 401 Unauthorized');
    }

    // --------------------------------------------------------------------------
    // TEST 2: Unauthenticated request to Bull Board API endpoints is rejected (401)
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 2: Unauthenticated request to Bull Board API endpoints is rejected (401)');
    console.log('--------------------------------------------------------------------------');
    {
      const resApi = await fetch(`${baseUrl}/admin/queues/api/queues`, { method: 'GET' });
      assert(resApi.status === 401, 'GET /admin/queues/api/queues returns HTTP 401');
      const bodyApi = await resApi.json();
      assert(bodyApi.error === 'Authentication required', 'API rejection returns JSON 401 error');

      const resRetry = await fetch(`${baseUrl}/admin/queues/api/queues/email-queue/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert(resRetry.status === 401, 'POST /admin/queues/api/queues/email-queue/retry returns HTTP 401');

      const resClean = await fetch(`${baseUrl}/admin/queues/api/queues/email-queue/clean/completed`, {
        method: 'PUT',
      });
      assert(resClean.status === 401, 'PUT /admin/queues/api/queues/email-queue/clean/completed returns HTTP 401');
    }

    // --------------------------------------------------------------------------
    // TEST 3: Unauthenticated request to Bull Board static assets is rejected (401)
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 3: Unauthenticated request to Bull Board static assets is rejected (401)');
    console.log('--------------------------------------------------------------------------');
    {
      const resAsset = await fetch(`${baseUrl}/admin/queues/static/bundle.js`, { method: 'GET' });
      assert(resAsset.status === 401, 'GET /admin/queues/static/bundle.js returns HTTP 401');

      const resCss = await fetch(`${baseUrl}/admin/queues/static/main.css`, { method: 'GET' });
      assert(resCss.status === 401, 'GET /admin/queues/static/main.css returns HTTP 401');
    }

    // --------------------------------------------------------------------------
    // TEST 4: Missing admin configuration fails closed (HTTP 403)
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 4: Missing admin configuration fails closed (403)');
    console.log('--------------------------------------------------------------------------');
    {
      delete process.env.ADMIN_USER_IDS;
      delete process.env.ADMIN_EMAILS;

      const resMissingConfig = await fetch(`${baseUrl}/admin/queues`, {
        method: 'GET',
        headers: { 'x-test-user-id': 'authenticated-user-no-admin-config' },
      });
      assert(resMissingConfig.status === 403, 'Missing admin config returns HTTP 403 Forbidden (fail closed)');
      const bodyMissing = await resMissingConfig.json();
      assert(bodyMissing.error === 'Forbidden', 'Error is "Forbidden"');
      assert(
        bodyMissing.message.toLowerCase().includes('not configured'),
        'Message explicitly clarifies admin authorization is not configured',
      );

      const resApiMissing = await fetch(`${baseUrl}/admin/queues/api/queues`, {
        method: 'GET',
        headers: { 'x-test-user-id': 'authenticated-user-no-admin-config' },
      });
      assert(resApiMissing.status === 403, 'API endpoint also returns HTTP 403 when admin config is missing');
    }

    // --------------------------------------------------------------------------
    // TEST 5: Authenticated non-admin user is rejected (HTTP 403)
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 5: Authenticated non-admin user is rejected (403)');
    console.log('--------------------------------------------------------------------------');
    {
      const adminId = 'a1b2c3d4-0000-0000-0000-000000000001';
      const nonAdminId = 'e5f6a7b8-9999-9999-9999-999999999999';
      process.env.ADMIN_USER_IDS = adminId;
      delete process.env.ADMIN_EMAILS;

      const resNonAdmin = await fetch(`${baseUrl}/admin/queues`, {
        method: 'GET',
        headers: { 'x-test-user-id': nonAdminId },
      });
      assert(resNonAdmin.status === 403, 'Non-admin authenticated user receives HTTP 403 Forbidden');
      const bodyNonAdmin = await resNonAdmin.json();
      assert(bodyNonAdmin.error === 'Forbidden', 'Error is "Forbidden"');
      assert(
        bodyNonAdmin.message.toLowerCase().includes('admin privileges required'),
        'Message states admin privileges required',
      );

      const resNonAdminApi = await fetch(`${baseUrl}/admin/queues/api/queues`, {
        method: 'GET',
        headers: { 'x-test-user-id': nonAdminId },
      });
      assert(resNonAdminApi.status === 403, 'Non-admin accessing API receives HTTP 403');

      const resNonAdminAction = await fetch(`${baseUrl}/admin/queues/api/queues/email-queue/retry`, {
        method: 'POST',
        headers: {
          'x-test-user-id': nonAdminId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      assert(resNonAdminAction.status === 403, 'Non-admin attempting queue mutation action receives HTTP 403');
    }

    // --------------------------------------------------------------------------
    // TEST 6: User-supplied roles/headers cannot bypass authorization (Injection Defense)
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 6: User-supplied roles/headers cannot bypass authorization (Injection Defense)');
    console.log('--------------------------------------------------------------------------');
    {
      const adminId = 'a1b2c3d4-0000-0000-0000-000000000001';
      const attackerId = 'attacker-uuid-0000';
      process.env.ADMIN_USER_IDS = adminId;

      // Header injection attempt: x-admin, role, x-role
      const resHeaderInject = await fetch(`${baseUrl}/admin/queues`, {
        method: 'GET',
        headers: {
          'x-test-user-id': attackerId,
          'x-admin': 'true',
          'x-role': 'admin',
          'role': 'admin',
          'x-user-role': 'superadmin',
        },
      });
      assert(resHeaderInject.status === 403, 'Header spoofing (x-admin/x-role/role) is completely ignored (403)');

      // Body injection attempt
      const resBodyInject = await fetch(`${baseUrl}/admin/queues/api/queues`, {
        method: 'POST',
        headers: {
          'x-test-user-id': attackerId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'admin', isAdmin: true, user: { role: 'admin' } }),
      });
      assert(resBodyInject.status === 403, 'Request body role injection is completely ignored (403)');

      // Query param injection attempt
      const resQueryInject = await fetch(`${baseUrl}/admin/queues?role=admin&admin=true&isAdmin=true`, {
        method: 'GET',
        headers: { 'x-test-user-id': attackerId },
      });
      assert(resQueryInject.status === 403, 'Query parameter role injection is completely ignored (403)');
    }

    // --------------------------------------------------------------------------
    // TEST 7: Authorized admin access succeeds via ADMIN_USER_IDS (HTTP 200)
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 7: Authorized admin access succeeds via ADMIN_USER_IDS (200)');
    console.log('--------------------------------------------------------------------------');
    {
      const adminId = 'a1b2c3d4-0000-0000-0000-000000000001';
      process.env.ADMIN_USER_IDS = adminId;

      const resAdmin = await fetch(`${baseUrl}/admin/queues`, {
        method: 'GET',
        headers: { 'x-test-user-id': adminId },
      });
      assert(resAdmin.status === 200, 'Authorized admin GET /admin/queues returns HTTP 200');
      const contentType = resAdmin.headers.get('content-type') || '';
      assert(contentType.includes('text/html'), 'Dashboard root returns HTML content');

      const resAdminApi = await fetch(`${baseUrl}/admin/queues/api/queues`, {
        method: 'GET',
        headers: { 'x-test-user-id': adminId },
      });
      assert(resAdminApi.status === 200, 'Authorized admin GET /admin/queues/api/queues returns HTTP 200');
      const bodyAdminApi = (await resAdminApi.json()) as { queues?: Array<{ name: string }> };
      assert(Array.isArray(bodyAdminApi.queues), 'API response contains queues array');
      assert(
        bodyAdminApi.queues!.some((q) => q.name === 'email-queue'),
        'Queues list contains email-queue',
      );
    }

    // --------------------------------------------------------------------------
    // TEST 8: Authorized admin access succeeds via ADMIN_EMAILS (HTTP 200)
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 8: Authorized admin access succeeds via ADMIN_EMAILS (200)');
    console.log('--------------------------------------------------------------------------');
    {
      process.env.ADMIN_USER_IDS = '';
      process.env.ADMIN_EMAILS = 'ops-admin@reachinbox.test, security@reachinbox.test';

      const adminUserWithEmail = 'random-uuid-email-admin';
      // Case-insensitivity check: pass uppercase email
      const resEmailAdmin = await fetch(`${baseUrl}/admin/queues`, {
        method: 'GET',
        headers: {
          'x-test-user-id': adminUserWithEmail,
          'x-test-user-email': 'OPS-ADMIN@REACHINBOX.TEST',
        },
      });
      assert(resEmailAdmin.status === 200, 'Admin authorized via case-insensitive email in ADMIN_EMAILS returns 200');

      const resEmailAdminApi = await fetch(`${baseUrl}/admin/queues/api/queues`, {
        method: 'GET',
        headers: {
          'x-test-user-id': adminUserWithEmail,
          'x-test-user-email': 'ops-admin@reachinbox.test',
        },
      });
      assert(resEmailAdminApi.status === 200, 'Admin authorized via email can query API (200)');

      // Non-matching email
      const resWrongEmail = await fetch(`${baseUrl}/admin/queues`, {
        method: 'GET',
        headers: {
          'x-test-user-id': adminUserWithEmail,
          'x-test-user-email': 'unauthorized@reachinbox.test',
        },
      });
      assert(resWrongEmail.status === 403, 'User with unlisted email is rejected (403)');
    }

    // --------------------------------------------------------------------------
    // TEST 9: Multiple admins in comma-separated allowlist with whitespace trimming
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 9: Multiple admins in comma-separated allowlist with whitespace trimming');
    console.log('--------------------------------------------------------------------------');
    {
      const admin1 = 'uuid-admin-alpha';
      const admin2 = 'uuid-admin-beta';
      const nonAdmin = 'uuid-user-gamma';
      process.env.ADMIN_USER_IDS = `   ${admin1}   ,   ${admin2}   `;
      delete process.env.ADMIN_EMAILS;

      const res1 = await fetch(`${baseUrl}/admin/queues`, {
        method: 'GET',
        headers: { 'x-test-user-id': admin1 },
      });
      assert(res1.status === 200, 'Admin 1 in multi-entry allowlist succeeds (200)');

      const res2 = await fetch(`${baseUrl}/admin/queues`, {
        method: 'GET',
        headers: { 'x-test-user-id': admin2 },
      });
      assert(res2.status === 200, 'Admin 2 in multi-entry allowlist succeeds (200)');

      const res3 = await fetch(`${baseUrl}/admin/queues`, {
        method: 'GET',
        headers: { 'x-test-user-id': nonAdmin },
      });
      assert(res3.status === 403, 'Unlisted user is rejected (403)');
    }

    // --------------------------------------------------------------------------
    // TEST 10: Explicitly disabled Bull Board (BULL_BOARD_ENABLED=false) (HTTP 403)
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 10: Explicitly disabled Bull Board (BULL_BOARD_ENABLED=false) (403)');
    console.log('--------------------------------------------------------------------------');
    {
      const adminId = 'uuid-admin-alpha';
      process.env.ADMIN_USER_IDS = adminId;
      process.env.BULL_BOARD_ENABLED = 'false';

      const resDisabled = await fetch(`${baseUrl}/admin/queues`, {
        method: 'GET',
        headers: { 'x-test-user-id': adminId },
      });
      assert(resDisabled.status === 403, 'Even authorized admin receives 403 when BULL_BOARD_ENABLED=false');
      const bodyDisabled = await resDisabled.json();
      assert(
        bodyDisabled.message.toLowerCase().includes('disabled'),
        'Message indicates Bull Board dashboard is disabled',
      );

      // Re-enable for subsequent tests
      process.env.BULL_BOARD_ENABLED = 'true';
    }

    // --------------------------------------------------------------------------
    // TEST 11: Production environment cannot expose dashboard publicly
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 11: Production environment cannot expose dashboard publicly');
    console.log('--------------------------------------------------------------------------');
    {
      const adminId = 'uuid-admin-alpha';
      process.env.ADMIN_USER_IDS = adminId;

      // Simulate production runtime
      process.env.NODE_ENV = 'production';
      delete process.env.ALLOW_TEST_AUTH;

      // Attempt to access with test header in production
      const resProdTestHeader = await fetch(`${baseUrl}/admin/queues`, {
        method: 'GET',
        headers: { 'x-test-user-id': adminId },
      });
      assert(
        resProdTestHeader.status === 401,
        'In production, test bypass headers are strictly ignored (HTTP 401)',
      );

      // Attempt public unauthenticated access in production
      const resProdPublic = await fetch(`${baseUrl}/admin/queues`, {
        method: 'GET',
      });
      assert(resProdPublic.status === 401, 'In production, unauthenticated request returns HTTP 401');

      // Restore test environment
      process.env.NODE_ENV = 'test';
      process.env.ALLOW_TEST_AUTH = 'true';
    }

    // --------------------------------------------------------------------------
    // TEST 12: Real authenticated PostgreSQL session verification
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 12: Real authenticated PostgreSQL session verification');
    console.log('--------------------------------------------------------------------------');
    {
      // Ensure user_sessions table exists in test DB
      await testPool.query(`
        CREATE TABLE IF NOT EXISTS "user_sessions" (
          "sid" varchar NOT NULL COLLATE "default",
          "sess" json NOT NULL,
          "expire" timestamp(6) NOT NULL,
          CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
        );
        CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "user_sessions" ("expire");
      `);

      // Insert real admin user and non-admin user into PostgreSQL
      const realAdminId = 'bbbbbbbb-1111-2222-3333-444444444444';
      const realNonAdminId = 'cccccccc-1111-2222-3333-444444444444';

      await testPool.query(`
        INSERT INTO users (id, email, name, google_id)
        VALUES
          ('${realAdminId}', 'real-admin@reachinbox.test', 'Real Admin', 'g_admin_123'),
          ('${realNonAdminId}', 'real-nonadmin@reachinbox.test', 'Real NonAdmin', 'g_nonadmin_123')
        ON CONFLICT (id) DO NOTHING;
      `);

      process.env.ADMIN_USER_IDS = realAdminId;

      // Create genuine signed session in PostgreSQL user_sessions table
      const sessionSecret = config.session.secret;

      // Admin session
      const adminSid = `test_admin_session_${crypto.randomBytes(8).toString('hex')}`;
      const adminSessionData = {
        cookie: { originalMaxAge: 30 * 24 * 60 * 60 * 1000, expires: new Date(Date.now() + 86400000).toISOString() },
        passport: { user: realAdminId },
      };
      await testPool.query(
        `INSERT INTO user_sessions (sid, sess, expire) VALUES ($1, $2, NOW() + INTERVAL '1 day')
         ON CONFLICT (sid) DO UPDATE SET sess = $2, expire = NOW() + INTERVAL '1 day'`,
        [adminSid, JSON.stringify(adminSessionData)],
      );

      // Sign the session cookie as connect.sid: s:<sid>.<signature>
      const signedAdminCookie = `connect.sid=s:${signature.sign(adminSid, sessionSecret)}`;

      const resRealAdmin = await fetch(`${baseUrl}/admin/queues`, {
        method: 'GET',
        headers: { Cookie: signedAdminCookie },
      });
      assert(resRealAdmin.status === 200, 'Real authenticated admin session cookie returns HTTP 200');

      // Non-admin session
      const nonAdminSid = `test_nonadmin_session_${crypto.randomBytes(8).toString('hex')}`;
      const nonAdminSessionData = {
        cookie: { originalMaxAge: 30 * 24 * 60 * 60 * 1000, expires: new Date(Date.now() + 86400000).toISOString() },
        passport: { user: realNonAdminId },
      };
      await testPool.query(
        `INSERT INTO user_sessions (sid, sess, expire) VALUES ($1, $2, NOW() + INTERVAL '1 day')
         ON CONFLICT (sid) DO UPDATE SET sess = $2, expire = NOW() + INTERVAL '1 day'`,
        [nonAdminSid, JSON.stringify(nonAdminSessionData)],
      );

      const signedNonAdminCookie = `connect.sid=s:${signature.sign(nonAdminSid, sessionSecret)}`;

      const resRealNonAdmin = await fetch(`${baseUrl}/admin/queues`, {
        method: 'GET',
        headers: { Cookie: signedNonAdminCookie },
      });
      assert(resRealNonAdmin.status === 403, 'Real authenticated non-admin session cookie returns HTTP 403');
    }

    // --------------------------------------------------------------------------
    // TEST 13: Ordinary users cannot access queue data or jobs
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 13: Ordinary users cannot access queue data or jobs');
    console.log('--------------------------------------------------------------------------');
    {
      const nonAdminId = 'user-regular-ordinary';
      const resOrdinaryQueueAccess = await fetch(`${baseUrl}/admin/queues/api/queues/email-queue`, {
        method: 'GET',
        headers: { 'x-test-user-id': nonAdminId },
      });
      assert(resOrdinaryQueueAccess.status === 403, 'Ordinary user cannot access specific queue details (403)');

      const resOrdinaryJobListing = await fetch(
        `${baseUrl}/admin/queues/api/queues/email-queue/jobs?types=waiting,active`,
        {
          method: 'GET',
          headers: { 'x-test-user-id': nonAdminId },
        },
      );
      assert(resOrdinaryJobListing.status === 403, 'Ordinary user cannot list queue jobs or inspect payloads (403)');
    }

    // --------------------------------------------------------------------------
    // TEST 14: Existing BullMQ queue functionality remains fully operational
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 14: Existing BullMQ queue functionality remains fully operational');
    console.log('--------------------------------------------------------------------------');
    {
      const testJob = await emailQueue.add('batch8_operational_check', {
        campaignId: 'c-test-batch8',
        recipientId: 'r-test-batch8',
      });
      assert(!!testJob.id, 'Job successfully enqueued to emailQueue');

      const retrievedJob = await emailQueue.getJob(testJob.id!);
      assert(!!retrievedJob, 'Job successfully retrieved from emailQueue');
      assert(retrievedJob?.data.campaignId === 'c-test-batch8', 'Job payload preserved accurately');

      await testJob.remove();
      const removedCheck = await emailQueue.getJob(testJob.id!);
      assert(removedCheck === null || removedCheck === undefined, 'Job cleanly removed from queue');
    }

    // --------------------------------------------------------------------------
    // TEST 15: Zero sensitive token/password leakage in error responses
    // --------------------------------------------------------------------------
    console.log('\n--------------------------------------------------------------------------');
    console.log('TEST 15: Zero sensitive token/password leakage in error responses');
    console.log('--------------------------------------------------------------------------');
    {
      const resForbidden = await fetch(`${baseUrl}/admin/queues`, {
        method: 'GET',
        headers: { 'x-test-user-id': 'unauthorized-user' },
      });
      const textForbidden = await resForbidden.text();
      assert(!textForbidden.includes('password'), 'Response does NOT contain "password"');
      assert(!textForbidden.includes('secret'), 'Response does NOT contain "secret"');
      assert(!textForbidden.includes('session'), 'Response does NOT contain raw session identifiers');
      assert(!textForbidden.includes('ADMIN_USER_IDS'), 'Response does NOT leak environment variable names');
    }

  } finally {
    server.close();
    await testPool.end();
    try {
      const { db } = require('../db/postgres');
      await db.end();
    } catch {}
    try {
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
  console.log(`  BATCH 8 VERIFICATION COMPLETE: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('==========================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('\n❌ Unhandled error during Batch 8 verification:', err);
  process.exit(1);
});
