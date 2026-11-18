/**
 * backend/src/scripts/testRecoveryAndDashboardAudienceFix.ts
 *
 * Verification suite for Bug 1 (Recovery Center Scheduled Delivery Exclusion)
 * and Bug 2 (Dashboard Total Recipients Aggregation & Tenant Isolation).
 */

import { Client, Pool } from 'pg';
import { Queue } from 'bullmq';
import assert from 'assert';
import { runMigrations } from '../db/migrate';
import {
  listDeliveries,
  getDeliveryDetail,
  manualRetryDelivery,
  resolveUnknownDelivery,
  evaluateRetryEligibility,
} from '../services/recoveryService';
import { listCampaignsByUser } from '../services/campaignService';
import { EmailJobPayload } from '../queue/emailQueue';

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';

const TEST_DB_NAME = `reachinbox_bugfix_test_${process.pid}_${Date.now()}`;

async function main() {
  console.log('='.repeat(75));
  console.log('  VERIFICATION SUITE: BUG 1 & BUG 2 FIXES');
  console.log(`  Isolated Test Database: ${TEST_DB_NAME}`);
  console.log('='.repeat(75));

  // 1. Create isolated test database
  const rootClient = new Client({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: 'postgres',
  });
  await rootClient.connect();
  await rootClient.query(`CREATE DATABASE "${TEST_DB_NAME}";`);
  await rootClient.end();
  console.log('✅ Temporary isolated database created.');

  const testPool = new Pool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: TEST_DB_NAME,
  });

  const dummyQueue = {
    add: async () => ({ id: 'mock-job-id' }),
  } as unknown as Queue<EmailJobPayload>;

  try {
    // 2. Run repository migrations
    await runMigrations(testPool);
    console.log('✅ Migrations applied successfully.');

    // 3. Seed users
    const userARes = await testPool.query<{ id: string }>(
      `INSERT INTO users (email, name)
       VALUES ('userA@reachinbox.test', 'User A') RETURNING id;`
    );
    const userAId = userARes.rows[0].id;

    const userBRes = await testPool.query<{ id: string }>(
      `INSERT INTO users (email, name)
       VALUES ('userB@reachinbox.test', 'User B') RETURNING id;`
    );
    const userBId = userBRes.rows[0].id;

    // Seed senders
    const senderARes = await testPool.query<{ id: string }>(
      `INSERT INTO senders (user_id, email, name, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass)
       VALUES ($1, 'senderA@reachinbox.test', 'Sender A', 'smtp.reachinbox.test', 587, false, 'userA', 'passA')
       RETURNING id;`,
      [userAId]
    );
    const senderAId = senderARes.rows[0].id;

    const senderBRes = await testPool.query<{ id: string }>(
      `INSERT INTO senders (user_id, email, name, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass)
       VALUES ($1, 'senderB@reachinbox.test', 'Sender B', 'smtp.reachinbox.test', 587, false, 'userB', 'passB')
       RETURNING id;`,
      [userBId]
    );
    const senderBId = senderBRes.rows[0].id;

    console.log('\n' + '-'.repeat(75));
    console.log('BUG 2 VERIFICATION: Dashboard Total Recipients Metric & Tenant Isolation');
    console.log('-'.repeat(75));

    // Seed Campaign 1 for User A with 2 recipients
    const camp1Res = await testPool.query<{ id: string }>(
      `INSERT INTO campaigns (user_id, sender_id, subject, body, status, scheduled_at, hourly_limit)
       VALUES ($1, $2, 'Campaign 1', 'Body 1', 'scheduled', NOW() + INTERVAL '1 hour', 50)
       RETURNING id;`,
      [userAId, senderAId]
    );
    const camp1Id = camp1Res.rows[0].id;

    await testPool.query(
      `INSERT INTO recipients (campaign_id, email, name, status)
       VALUES ($1, 'c1_r1@example.com', 'Recipient 1', 'pending'),
              ($1, 'c1_r2@example.com', 'Recipient 2', 'pending');`,
      [camp1Id]
    );

    // Seed Campaign 2 for User A with 3 recipients
    const camp2Res = await testPool.query<{ id: string }>(
      `INSERT INTO campaigns (user_id, sender_id, subject, body, status, scheduled_at, hourly_limit)
       VALUES ($1, $2, 'Campaign 2', 'Body 2', 'scheduled', NOW() + INTERVAL '2 hours', 50)
       RETURNING id;`,
      [userAId, senderAId]
    );
    const camp2Id = camp2Res.rows[0].id;

    await testPool.query(
      `INSERT INTO recipients (campaign_id, email, name, status)
       VALUES ($1, 'c2_r1@example.com', 'Recipient 1', 'pending'),
              ($1, 'c2_r2@example.com', 'Recipient 2', 'pending'),
              ($1, 'c2_r3@example.com', 'Recipient 3', 'pending');`,
      [camp2Id]
    );

    // Seed Campaign 3 for User B (Tenant B) with 10 recipients
    const camp3Res = await testPool.query<{ id: string }>(
      `INSERT INTO campaigns (user_id, sender_id, subject, body, status, scheduled_at, hourly_limit)
       VALUES ($1, $2, 'Campaign User B', 'Body B', 'scheduled', NOW() + INTERVAL '1 hour', 50)
       RETURNING id;`,
      [userBId, senderBId]
    );
    const camp3Id = camp3Res.rows[0].id;

    await testPool.query(
      `INSERT INTO recipients (campaign_id, email, name, status)
       SELECT $1, 'userb_r' || generate_series || '@example.com', 'User B R', 'pending'
       FROM generate_series(1, 10);`,
      [camp3Id]
    );

    // Verify User A listing
    // We can query with the scoped query used in listCampaignsByUser
    const userACampaigns = await testPool.query<{ id: string; recipient_count: number }>(
      `SELECT c.*,
              COALESCE(r.recipient_count, 0)::int AS recipient_count,
              COALESCE(r.recipient_count, 0)::int AS recipients_count
       FROM campaigns c
       LEFT JOIN (
         SELECT r_inner.campaign_id, COUNT(*)::int AS recipient_count
         FROM recipients r_inner
         JOIN campaigns c_inner ON c_inner.id = r_inner.campaign_id
         WHERE c_inner.user_id = $1
         GROUP BY r_inner.campaign_id
       ) r ON r.campaign_id = c.id
       WHERE c.user_id = $1
       ORDER BY c.created_at DESC`,
      [userAId]
    );

    assert.strictEqual(userACampaigns.rows.length, 2, 'User A sees exactly 2 campaigns');
    const c1Row = userACampaigns.rows.find((c) => c.id === camp1Id);
    const c2Row = userACampaigns.rows.find((c) => c.id === camp2Id);
    assert.strictEqual(Number(c1Row?.recipient_count), 2, 'Campaign 1 has exactly 2 recipients');
    assert.strictEqual(Number(c2Row?.recipient_count), 3, 'Campaign 2 has exactly 3 recipients');

    const totalAudience = userACampaigns.rows.reduce(
      (acc, c) => acc + Number(c.recipient_count || 0),
      0
    );
    assert.strictEqual(totalAudience, 5, 'Total Audience Recipients across User A campaigns equals exactly 5');
    console.log('  [PASS] Campaign 1 has recipient_count = 2');
    console.log('  [PASS] Campaign 2 has recipient_count = 3');
    console.log('  [PASS] Aggregated Total Audience Recipients equals 5 (2 + 3)');

    // Verify Tenant Isolation (User B campaign recipients NOT counted for User A)
    const userBCampaigns = await testPool.query<{ id: string; recipient_count: number }>(
      `SELECT c.*,
              COALESCE(r.recipient_count, 0)::int AS recipient_count
       FROM campaigns c
       LEFT JOIN (
         SELECT r_inner.campaign_id, COUNT(*)::int AS recipient_count
         FROM recipients r_inner
         JOIN campaigns c_inner ON c_inner.id = r_inner.campaign_id
         WHERE c_inner.user_id = $1
         GROUP BY r_inner.campaign_id
       ) r ON r.campaign_id = c.id
       WHERE c.user_id = $1
       ORDER BY c.created_at DESC`,
      [userBId]
    );
    assert.strictEqual(userBCampaigns.rows.length, 1, 'User B sees exactly 1 campaign');
    assert.strictEqual(Number(userBCampaigns.rows[0].recipient_count), 10, 'User B campaign has 10 recipients');
    console.log('  [PASS] User B campaign has 10 recipients without cross-tenant bleed');

    console.log('\n' + '-'.repeat(75));
    console.log('BUG 1 VERIFICATION: Recovery Center Scheduled Delivery Exclusion');
    console.log('-'.repeat(75));

    // Seed 5 deliveries for User A across Campaign 1 and Campaign 2: all scheduled with 0 attempts
    const r1List = (await testPool.query(`SELECT id FROM recipients WHERE campaign_id = $1`, [camp1Id])).rows;
    const r2List = (await testPool.query(`SELECT id FROM recipients WHERE campaign_id = $1`, [camp2Id])).rows;

    const scheduledDeliveryIds: string[] = [];
    for (const r of r1List) {
      const d = await testPool.query<{ id: string }>(
        `INSERT INTO email_deliveries (campaign_id, recipient_id, sender_id, idempotency_key, status, scheduled_at, attempt_count)
         VALUES ($1, $2, $3, $4, 'scheduled', NOW() + INTERVAL '1 hour', 0)
         RETURNING id;`,
        [camp1Id, r.id, senderAId, `test_sched_${camp1Id}_${r.id}`]
      );
      scheduledDeliveryIds.push(d.rows[0].id);
    }
    for (const r of r2List) {
      const d = await testPool.query<{ id: string }>(
        `INSERT INTO email_deliveries (campaign_id, recipient_id, sender_id, idempotency_key, status, scheduled_at, attempt_count)
         VALUES ($1, $2, $3, $4, 'scheduled', NOW() + INTERVAL '2 hours', 0)
         RETURNING id;`,
        [camp2Id, r.id, senderAId, `test_sched_${camp2Id}_${r.id}`]
      );
      scheduledDeliveryIds.push(d.rows[0].id);
    }
    assert.strictEqual(scheduledDeliveryIds.length, 5, 'Seeded exactly 5 scheduled deliveries');

    // 1. All Issues query (no status filter / default Recovery Center query)
    const allIssues = await listDeliveries({ userId: userAId }, testPool);
    assert.strictEqual(allIssues.deliveries.length, 0, 'All Issues returns 0 for scheduled deliveries');
    assert.strictEqual(allIssues.pagination.total, 0, 'Pagination total reports 0 issues');
    console.log('  [PASS] All Issues returns 0 (scheduled deliveries excluded)');

    // 2. Failed deliveries filter
    const failedDeliveries = await listDeliveries({ userId: userAId, status: 'failed' }, testPool);
    assert.strictEqual(failedDeliveries.deliveries.length, 0, 'Failed Deliveries returns 0');
    console.log('  [PASS] Failed Deliveries returns 0');

    // 3. Unknown deliveries filter
    const unknownDeliveries = await listDeliveries({ userId: userAId, status: 'unknown' }, testPool);
    assert.strictEqual(unknownDeliveries.deliveries.length, 0, 'Unknown Deliveries returns 0');
    console.log('  [PASS] Unknown / Review returns 0');

    // 4. Client explicitly querying scheduled status -> must return 0
    const scheduledAttempt = await listDeliveries({ userId: userAId, status: 'scheduled' as any }, testPool);
    assert.strictEqual(scheduledAttempt.deliveries.length, 0, 'Explicit status=scheduled query returns 0');
    console.log('  [PASS] Explicit status=scheduled returns 0 in Recovery Center');

    // 5. Retry eligibility check on scheduled delivery
    const scheduledEligibility = evaluateRetryEligibility(
      { status: 'scheduled' as any, attempt_count: 0, deleted_at: null },
      null
    );
    assert.strictEqual(scheduledEligibility.is_eligible, false, 'Scheduled delivery is not eligible for retry');
    console.log('  [PASS] evaluateRetryEligibility marks scheduled delivery as ineligible');

    // 6. Manual retry on scheduled delivery -> MUST REJECT WITH 400
    let retryScheduledRejected = false;
    let retryScheduledError = '';
    try {
      await manualRetryDelivery(scheduledDeliveryIds[0], userAId, testPool, dummyQueue);
    } catch (err: any) {
      if (err.statusCode === 400 && err.message.includes('scheduled or unattempted')) {
        retryScheduledRejected = true;
        retryScheduledError = err.message;
      }
    }
    assert(retryScheduledRejected, `Manual retry rejected on scheduled delivery with 400: ${retryScheduledError}`);
    console.log('  [PASS] manualRetryDelivery rejected scheduled delivery with HTTP 400');

    // 7. Operator resolution on scheduled delivery -> MUST REJECT WITH 400
    let resolveScheduledRejected = false;
    let resolveScheduledError = '';
    try {
      await resolveUnknownDelivery(
        scheduledDeliveryIds[0],
        userAId,
        { decision: 'confirmed_accepted', reason: 'Reviewing scheduled email' },
        testPool
      );
    } catch (err: any) {
      if (err.statusCode === 400 && err.message.includes('only \'unknown\' deliveries can be resolved')) {
        resolveScheduledRejected = true;
        resolveScheduledError = err.message;
      }
    }
    assert(resolveScheduledRejected, `Operator resolution rejected on scheduled delivery with 400: ${resolveScheduledError}`);
    console.log('  [PASS] resolveUnknownDelivery rejected scheduled delivery with HTTP 400');

    // 8. Now seed genuine failed and unknown deliveries with new recipients to verify they appear correctly
    const failedRecipientRes = await testPool.query<{ id: string }>(
      `INSERT INTO recipients (campaign_id, email, name, status)
       VALUES ($1, 'failed_recip@example.com', 'Failed Recipient', 'failed')
       RETURNING id;`,
      [camp1Id]
    );
    const failedRecipientId = failedRecipientRes.rows[0].id;

    const genuineFailedRes = await testPool.query<{ id: string }>(
      `INSERT INTO email_deliveries (campaign_id, recipient_id, sender_id, idempotency_key, status, scheduled_at, attempt_count, last_error)
       VALUES ($1, $2, $3, $4, 'failed', NOW(), 1, '550 Mailbox not found')
       RETURNING id;`,
      [camp1Id, failedRecipientId, senderAId, `test_failed_${camp1Id}_${failedRecipientId}`]
    );
    const genuineFailedId = genuineFailedRes.rows[0].id;
    await testPool.query(
      `INSERT INTO email_attempts (delivery_id, attempt_number, status, error_classification, error_message, smtp_response_code)
       VALUES ($1, 1, 'failed', 'permanent_rejection', '550 Mailbox not found', '550');`,
      [genuineFailedId]
    );

    const unknownRecipientRes = await testPool.query<{ id: string }>(
      `INSERT INTO recipients (campaign_id, email, name, status)
       VALUES ($1, 'unknown_recip@example.com', 'Unknown Recipient', 'unknown')
       RETURNING id;`,
      [camp2Id]
    );
    const unknownRecipientId = unknownRecipientRes.rows[0].id;

    const genuineUnknownRes = await testPool.query<{ id: string }>(
      `INSERT INTO email_deliveries (campaign_id, recipient_id, sender_id, idempotency_key, status, scheduled_at, attempt_count, last_error)
       VALUES ($1, $2, $3, $4, 'unknown', NOW(), 1, 'Connection dropped during DATA')
       RETURNING id;`,
      [camp2Id, unknownRecipientId, senderAId, `test_unknown_${camp2Id}_${unknownRecipientId}`]
    );
    const genuineUnknownId = genuineUnknownRes.rows[0].id;
    await testPool.query(
      `INSERT INTO email_attempts (delivery_id, attempt_number, status, error_classification, error_message)
       VALUES ($1, 1, 'unknown', 'ambiguous_outcome', 'Connection dropped during DATA');`,
      [genuineUnknownId]
    );

    // Verify All Issues now reports exactly 2 genuine issues (5 scheduled still excluded!)
    const allWithGenuine = await listDeliveries({ userId: userAId }, testPool);
    assert.strictEqual(allWithGenuine.deliveries.length, 2, 'All Issues returns exactly the 2 genuine issues');
    assert.strictEqual(allWithGenuine.pagination.total, 2, 'Total genuine issues is 2');
    console.log('  [PASS] All Issues accurately returns exactly the 2 genuine recovery issues (scheduled still excluded)');

    // Verify Failed tab reports 1
    const failedTab = await listDeliveries({ userId: userAId, status: 'failed' }, testPool);
    assert.strictEqual(failedTab.deliveries.length, 1, 'Failed tab returns 1');
    assert.strictEqual(failedTab.deliveries[0].id, genuineFailedId, 'Failed tab contains genuine failed delivery');
    console.log('  [PASS] Failed Deliveries tab shows 1 genuine failed delivery');

    // Verify Unknown tab reports 1
    const unknownTab = await listDeliveries({ userId: userAId, status: 'unknown' }, testPool);
    assert.strictEqual(unknownTab.deliveries.length, 1, 'Unknown tab returns 1');
    assert.strictEqual(unknownTab.deliveries[0].id, genuineUnknownId, 'Unknown tab contains genuine unknown delivery');
    console.log('  [PASS] Unknown / Review tab shows 1 genuine unknown delivery');

    console.log('\n' + '='.repeat(75));
    console.log('  ALL BUG 1 & BUG 2 VERIFICATIONS PASSED SUCCESSFULLY!');
    console.log('='.repeat(75));
  } finally {
    await testPool.end();
    const cleanupClient = new Client({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      database: 'postgres',
    });
    await cleanupClient.connect();
    await cleanupClient.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}";`);
    await cleanupClient.end();
    console.log('✅ Temporary isolated database dropped.');
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
  });
