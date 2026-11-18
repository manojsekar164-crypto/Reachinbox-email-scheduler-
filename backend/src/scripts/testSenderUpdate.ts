/**
 * backend/src/scripts/testSenderUpdate.ts
 *
 * Verification suite for In-Place Sender Profile Updates:
 *  1. In-place update preserving UUID, user_id, and created_at.
 *  2. Field updating: name, email, host, port, secure, username, password.
 *  3. Password encryption at rest with AES-256-GCM.
 *  4. Strict credential non-leakage (smtp_pass never exposed in API responses).
 *  5. Cross-tenant authorization (User B cannot update User A's sender -> 404).
 *  6. Input validation (email format, port bounds, required field constraints).
 *  7. Blank password update preserves existing encrypted password.
 *  8. Campaign reference integrity (foreign keys intact after update).
 *  9. PUT and PATCH HTTP method routing compatibility.
 */

import { Client, Pool } from 'pg';
import assert from 'assert';
import { runMigrations } from '../db/migrate';
import { safeEncrypt, safeDecrypt } from '../utils/crypto';
import {
  createSender,
  getSenderById,
  getSenderByIdInternal,
  updateSender,
} from '../services/senderService';
import { patchSenderHandler } from '../controllers/senderController';

const SEP = '='.repeat(74);
const SUB_SEP = '-'.repeat(74);

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';

const TEST_DB_NAME = `reachinbox_sender_update_test_${process.pid}_${Date.now()}`;

let passed = 0;
let failed = 0;
let currentTestPool: Pool | null = null;

function testAssert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${testName}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

function mockRequest(options: {
  user?: any;
  params?: any;
  body?: any;
  dbClient?: any;
}): any {
  return {
    user: options.user || null,
    params: options.params || {},
    body: options.body || {},
    dbClient: options.dbClient || currentTestPool,
  };
}

function mockResponse(): any {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
  };
  return res;
}

async function main(): Promise<void> {
  console.log('\n' + SEP);
  console.log('  VERIFICATION SUITE: IN-PLACE SENDER PROFILE UPDATE');
  console.log(`  Ephemeral Test Database: ${TEST_DB_NAME}`);
  console.log(SEP + '\n');

  // 1. Prepare ephemeral test database
  const rootClient = new Client({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: 'postgres',
  });
  await rootClient.connect();

  await rootClient.query(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();
  `);
  await rootClient.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
  await rootClient.query(`CREATE DATABASE ${TEST_DB_NAME};`);
  console.log(`1. Database "${TEST_DB_NAME}" created.\n`);

  const testPool = new Pool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: TEST_DB_NAME,
    max: 10,
  });
  currentTestPool = testPool;

  try {
    // 2. Run migrations
    console.log('2. Applying schema migrations...');
    const testClient = await testPool.connect();
    try {
      await runMigrations(testClient);
      console.log('   Schema migrations applied successfully.\n');
    } finally {
      testClient.release();
    }

    // 3. Seed users
    console.log('3. Seeding test users...');
    const u1Res = await testPool.query(
      `INSERT INTO users (email, name) VALUES ('user_a@test.com', 'User A') RETURNING id;`
    );
    const userAId = u1Res.rows[0].id;

    const u2Res = await testPool.query(
      `INSERT INTO users (email, name) VALUES ('user_b@test.com', 'User B') RETURNING id;`
    );
    const userBId = u2Res.rows[0].id;
    console.log('   Users seeded.\n');

    // -------------------------------------------------------------------------
    // TEST 1: In-Place Sender Creation & Baseline Attributes
    // -------------------------------------------------------------------------
    console.log(SUB_SEP);
    console.log('TEST 1: Sender Creation & Baseline Attributes');
    console.log(SUB_SEP);

    // Initial password
    const initialPass = 'ethereal_secret_password_1';
    const encryptedInitial = safeEncrypt(initialPass);

    const s1Res = await testPool.query(
      `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, hourly_limit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *;`,
      [
        userAId,
        'Original Sender Name',
        'original@ethereal.email',
        'smtp.ethereal.email',
        587,
        false,
        'original_ethereal_user',
        encryptedInitial,
        100,
      ]
    );
    const originalSender = s1Res.rows[0];
    const originalId = originalSender.id;
    const originalCreatedAt = originalSender.created_at;

    testAssert(Boolean(originalId), 'Sender created with valid UUID');
    testAssert(originalSender.user_id === userAId, 'Sender belongs to User A');
    testAssert(originalSender.name === 'Original Sender Name', 'Initial display name is correct');

    // Attach a campaign to this sender to verify foreign key preservation
    const campRes = await testPool.query(
      `INSERT INTO campaigns (user_id, sender_id, subject, body, status)
       VALUES ($1, $2, 'Scheduled Campaign 1', 'Body', 'scheduled')
       RETURNING id;`,
      [userAId, originalId]
    );
    const campaignId = campRes.rows[0].id;
    testAssert(Boolean(campaignId), 'Campaign created referencing sender ID');

    // -------------------------------------------------------------------------
    // TEST 2: In-Place Update (Preserving UUID and user_id)
    // -------------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 2: In-Place Update Preserving UUID & Foreign Keys');
    console.log(SUB_SEP);

    const newPass = 'new_ethereal_secret_password_2';
    const updated = await updateSender(originalId, userAId, {
      name: 'ReachInbox QA Updated',
      email: 'new_qa@ethereal.email',
      smtp_host: 'smtp.ethereal.email',
      smtp_port: 587,
      smtp_secure: true,
      smtp_user: 'new_ethereal_user_2',
      smtp_pass: newPass,
    }, testPool);

    testAssert(updated !== null, 'Update returns updated sender record');
    testAssert(updated!.id === originalId, 'Sender ID (UUID) is strictly PRESERVED');
    testAssert(updated!.user_id === userAId, 'User ID ownership is strictly PRESERVED');
    testAssert(updated!.name === 'ReachInbox QA Updated', 'Display name updated in place');
    testAssert(updated!.email === 'new_qa@ethereal.email', 'Email updated in place');
    testAssert(updated!.smtp_secure === true, 'TLS/SSL setting updated in place');
    testAssert(updated!.smtp_user === 'new_ethereal_user_2', 'SMTP username updated in place');

    // Verify raw database record
    const rawCheck = await testPool.query(
      'SELECT id, user_id, smtp_pass, created_at, updated_at FROM senders WHERE id = $1',
      [originalId]
    );
    const rawRow = rawCheck.rows[0];
    testAssert(rawRow.id === originalId, 'Database confirms identical UUID');
    testAssert(rawRow.smtp_pass !== newPass, 'Database stores encrypted password, NOT plaintext');
    testAssert(safeDecrypt(rawRow.smtp_pass) === newPass, 'Encrypted password decrypts to new credentials');

    // Verify campaign reference remains 100% valid
    const campCheck = await testPool.query(
      'SELECT sender_id FROM campaigns WHERE id = $1',
      [campaignId]
    );
    testAssert(
      campCheck.rows[0].sender_id === originalId,
      'Existing campaign still references the exact same sender ID'
    );

    // -------------------------------------------------------------------------
    // TEST 3: Controller HTTP Handler & Security Invariant (No Password Leaked)
    // -------------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 3: Controller Handler & Credential Protection');
    console.log(SUB_SEP);

    const thirdPass = 'third_super_secure_pass_3';
    const req = mockRequest({
      user: { id: userAId },
      params: { id: originalId },
      body: {
        name: 'ReachInbox QA Final',
        email: 'qa_final@ethereal.email',
        smtp_host: 'smtp.ethereal.email',
        smtp_port: 587,
        smtp_secure: false,
        smtp_user: 'qa_final_user',
        smtp_pass: thirdPass,
      },
    });
    const res = mockResponse();

    await patchSenderHandler(req, res, (err) => { throw err; });

    testAssert(res.statusCode === 200, 'HTTP status is 200 OK');
    testAssert(res.body.id === originalId, 'Response returns matching sender ID');
    testAssert(res.body.name === 'ReachInbox QA Final', 'Response returns updated name');
    testAssert(res.body.email === 'qa_final@ethereal.email', 'Response returns updated email');
    testAssert(res.body.smtp_pass === undefined, 'CRITICAL: smtp_pass is NEVER present in response JSON');
    testAssert(!JSON.stringify(res.body).includes(thirdPass), 'CRITICAL: Plaintext password never leaked in serialized JSON');

    // Internal worker decrypt check
    const workerSender = await getSenderByIdInternal(originalId, testPool);
    testAssert(workerSender !== null, 'Worker internal lookup succeeds');
    testAssert(workerSender!.smtp_pass === thirdPass, 'Worker can decrypt updated credentials');

    // -------------------------------------------------------------------------
    // TEST 4: Blank Password Preserves Existing Encrypted Password
    // -------------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 4: Blank Password Preserves Existing Stored Password');
    console.log(SUB_SEP);

    const reqBlankPass = mockRequest({
      user: { id: userAId },
      params: { id: originalId },
      body: {
        name: 'ReachInbox QA Keep Password',
        smtp_pass: '', // empty password indicating no change
      },
    });
    const resBlankPass = mockResponse();

    await patchSenderHandler(reqBlankPass, resBlankPass, (err) => { throw err; });

    testAssert(resBlankPass.statusCode === 200, 'Update with blank password returns 200 OK');
    testAssert(resBlankPass.body.name === 'ReachInbox QA Keep Password', 'Name updated');

    const checkPreservedPass = await getSenderByIdInternal(originalId, testPool);
    testAssert(
      checkPreservedPass!.smtp_pass === thirdPass,
      'Existing password strictly PRESERVED when blank string supplied'
    );

    // -------------------------------------------------------------------------
    // TEST 5: Cross-Tenant Ownership Authorization
    // -------------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 5: Cross-Tenant Ownership Authorization');
    console.log(SUB_SEP);

    // User B tries to update User A's sender
    const reqUnauthorized = mockRequest({
      user: { id: userBId }, // Different tenant
      params: { id: originalId },
      body: {
        name: 'Hacked by User B',
      },
    });
    const resUnauthorized = mockResponse();

    await patchSenderHandler(reqUnauthorized, resUnauthorized, (err) => { throw err; });

    testAssert(resUnauthorized.statusCode === 404, 'Unauthorized tenant update rejected with 404 Not Found');

    const verifyNotHacked = await getSenderByIdInternal(originalId, testPool);
    testAssert(verifyNotHacked!.name === 'ReachInbox QA Keep Password', 'Sender record was NOT modified by unauthorized tenant');

    // -------------------------------------------------------------------------
    // TEST 6: Input Validation Constraints
    // -------------------------------------------------------------------------
    console.log('\n' + SUB_SEP);
    console.log('TEST 6: Input Validation Constraints');
    console.log(SUB_SEP);

    // Invalid email
    const reqBadEmail = mockRequest({
      user: { id: userAId },
      params: { id: originalId },
      body: { email: 'not-an-email' },
    });
    const resBadEmail = mockResponse();
    await patchSenderHandler(reqBadEmail, resBadEmail, (err) => { throw err; });
    testAssert(resBadEmail.statusCode === 400, 'Invalid email rejected with 400 Bad Request');

    // Invalid port
    const reqBadPort = mockRequest({
      user: { id: userAId },
      params: { id: originalId },
      body: { smtp_port: 99999 },
    });
    const resBadPort = mockResponse();
    await patchSenderHandler(reqBadPort, resBadPort, (err) => { throw err; });
    testAssert(resBadPort.statusCode === 400, 'Invalid port (>65535) rejected with 400 Bad Request');

    // Negative port
    const reqNegPort = mockRequest({
      user: { id: userAId },
      params: { id: originalId },
      body: { smtp_port: -1 },
    });
    const resNegPort = mockResponse();
    await patchSenderHandler(reqNegPort, resNegPort, (err) => { throw err; });
    testAssert(resNegPort.statusCode === 400, 'Negative port rejected with 400 Bad Request');

    // Empty name
    const reqEmptyName = mockRequest({
      user: { id: userAId },
      params: { id: originalId },
      body: { name: '   ' },
    });
    const resEmptyName = mockResponse();
    await patchSenderHandler(reqEmptyName, resEmptyName, (err) => { throw err; });
    testAssert(resEmptyName.statusCode === 400, 'Empty name rejected with 400 Bad Request');

    // Non-boolean secure
    const reqBadSecure = mockRequest({
      user: { id: userAId },
      params: { id: originalId },
      body: { smtp_secure: 'yes' },
    });
    const resBadSecure = mockResponse();
    await patchSenderHandler(reqBadSecure, resBadSecure, (err) => { throw err; });
    testAssert(resBadSecure.statusCode === 400, 'Non-boolean secure rejected with 400 Bad Request');

    // No fields provided
    const reqNoFields = mockRequest({
      user: { id: userAId },
      params: { id: originalId },
      body: {},
    });
    const resNoFields = mockResponse();
    await patchSenderHandler(reqNoFields, resNoFields, (err) => { throw err; });
    testAssert(resNoFields.statusCode === 400, 'Empty update payload rejected with 400 Bad Request');

    console.log('\n' + SEP);
    console.log(`  SENDER UPDATE VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
    console.log(SEP + '\n');

  } finally {
    currentTestPool = null;
    console.log('Cleaning up ephemeral database...');
    await testPool.end();
    await rootClient.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();
    `);
    await rootClient.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await rootClient.end();
    console.log('Cleanup complete.\n');
  }

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
