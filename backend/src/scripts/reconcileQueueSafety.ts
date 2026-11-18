/**
 * backend/src/scripts/reconcileQueueSafety.ts
 *
 * BullMQ Queue Reconciliation & Safety Verification Script.
 *
 * Performs:
 *  1. Re-check and safe removal of ONLY the 2 orphan test fixtures (IDs 1 & 2).
 *  2. Canonical reconciliation of the 5 QA deliveries (Campaign 1: 2, Campaign 2: 3).
 *  3. Idempotency test (second pass must enqueue 0 duplicates).
 *  4. Independent verification of queue safety and database consistency.
 */

import assert from 'assert';
import { db } from '../db/postgres';
import { emailQueue, EmailJobPayload } from '../queue/emailQueue';
import {
  reconcileScheduledDeliveries,
  ScheduledReconciliationResult,
} from '../services/outboxPublisher';

const SEP = '='.repeat(74);
const SUB_SEP = '-'.repeat(74);

const EXPECTED_CAMPAIGN_1 = 'e16cfef9-2dee-48e4-8326-ac809c46cf4a';
const EXPECTED_CAMPAIGN_2 = '0bb037a9-ae2d-468b-98a6-1c24e9268e3c';
const EXPECTED_SENDER_NAME = 'ReachInbox QA';
const EXPECTED_SENDER_HOST = 'smtp.ethereal.email';

async function main(): Promise<void> {
  console.log('\n' + SEP);
  console.log('  REACHINBOX — BULLMQ QUEUE RECONCILIATION & SAFETY VERIFICATION');
  console.log(SEP + '\n');

  // ===========================================================================
  // STEP 1: Verify and Remove Only the Two Orphan Test Fixture Jobs
  // ===========================================================================
  console.log('STEP 1: Inspecting & Removing Orphan Test Fixture Jobs...');
  console.log(SUB_SEP);

  const j1 = await emailQueue.getJob('1');
  const j2 = await emailQueue.getJob('2');

  const orphanRemovalLog: Array<{ id: string; state: string; messageId?: string }> = [];

  if (j1) {
    const state1 = await j1.getState();
    const data1 = j1.data as any;
    console.log(`  Job 1 found: state=${state1}, payload=${JSON.stringify(data1)}`);
    assert(state1 === 'waiting', 'Job 1 must be in waiting state');
    assert(data1.messageId === 'test-job-a1', 'Job 1 must match test-job-a1 fixture');

    // Confirm no corresponding database delivery record
    const dbCheck1 = await db.query(
      'SELECT id FROM email_deliveries WHERE campaign_id = $1 OR recipient_id = $2',
      [data1.campaignId, data1.recipientId]
    );
    assert(dbCheck1.rows.length === 0, 'Job 1 has NO corresponding application delivery record');

    await j1.remove();
    console.log('  ✅ Job 1 ("test-job-a1") safely removed using BullMQ API.');
    orphanRemovalLog.push({ id: '1', state: state1, messageId: data1.messageId });
  } else {
    console.log('  ℹ️  Job 1 is not present in queue.');
  }

  if (j2) {
    const state2 = await j2.getState();
    const data2 = j2.data as any;
    console.log(`  Job 2 found: state=${state2}, payload=${JSON.stringify(data2)}`);
    assert(state2 === 'waiting', 'Job 2 must be in waiting state');
    assert(data2.messageId === 'test-job-b-victim', 'Job 2 must match test-job-b-victim fixture');

    // Confirm no corresponding database delivery record
    const dbCheck2 = await db.query(
      'SELECT id FROM email_deliveries WHERE campaign_id = $1 OR recipient_id = $2',
      [data2.campaignId, data2.recipientId]
    );
    assert(dbCheck2.rows.length === 0, 'Job 2 has NO corresponding application delivery record');

    await j2.remove();
    console.log('  ✅ Job 2 ("test-job-b-victim") safely removed using BullMQ API.');
    orphanRemovalLog.push({ id: '2', state: state2, messageId: data2.messageId });
  } else {
    console.log('  ℹ️  Job 2 is not present in queue.');
  }

  // Verify orphans are completely removed
  const postRemoveJ1 = await emailQueue.getJob('1');
  const postRemoveJ2 = await emailQueue.getJob('2');
  assert(postRemoveJ1 === null || postRemoveJ1 === undefined, 'Job 1 confirmed removed from BullMQ');
  assert(postRemoveJ2 === null || postRemoveJ2 === undefined, 'Job 2 confirmed removed from BullMQ');
  console.log('  ✅ Confirmed: Zero orphan test jobs remaining in BullMQ.\n');

  // ===========================================================================
  // STEP 2: Database Integrity Audit for Scheduled QA Campaigns
  // ===========================================================================
  console.log('STEP 2: Auditing Database Records for Scheduled QA Campaigns...');
  console.log(SUB_SEP);

  // 1. Check Campaigns
  const campRes = await db.query(
    `SELECT c.id, c.subject, c.status, c.scheduled_at, s.name as sender_name, s.smtp_host
     FROM campaigns c
     LEFT JOIN senders s ON s.id = c.sender_id
     WHERE c.id IN ($1, $2)
     ORDER BY c.created_at ASC`,
    [EXPECTED_CAMPAIGN_1, EXPECTED_CAMPAIGN_2]
  );
  assert(campRes.rows.length === 2, 'Exactly 2 QA campaigns must exist in database');

  for (const c of campRes.rows) {
    console.log(`  Campaign: "${c.subject}" (${c.id})`);
    console.log(`    Status: ${c.status}, ScheduledAt: ${c.scheduled_at}`);
    console.log(`    Sender: ${c.sender_name} (${c.smtp_host})`);
    assert(c.status === 'scheduled', `Campaign ${c.id} must have status 'scheduled'`);
    assert(c.sender_name === EXPECTED_SENDER_NAME, `Campaign ${c.id} must use ${EXPECTED_SENDER_NAME}`);
    assert(c.smtp_host === EXPECTED_SENDER_HOST, `Campaign ${c.id} must use ${EXPECTED_SENDER_HOST}`);
  }

  // 2. Check Deliveries & Recipients
  const delivRes = await db.query(
    `SELECT ed.id as delivery_id, ed.campaign_id, ed.recipient_id, ed.status, ed.attempt_count,
            r.email as recipient_email
     FROM email_deliveries ed
     JOIN recipients r ON r.id = ed.recipient_id
     WHERE ed.campaign_id IN ($1, $2)
     ORDER BY ed.campaign_id, ed.created_at ASC`,
    [EXPECTED_CAMPAIGN_1, EXPECTED_CAMPAIGN_2]
  );

  const c1Deliveries = delivRes.rows.filter((d: any) => d.campaign_id === EXPECTED_CAMPAIGN_1);
  const c2Deliveries = delivRes.rows.filter((d: any) => d.campaign_id === EXPECTED_CAMPAIGN_2);

  assert(c1Deliveries.length === 2, 'Campaign 1 must have exactly 2 deliveries');
  assert(c2Deliveries.length === 3, 'Campaign 2 must have exactly 3 deliveries');
  assert(delivRes.rows.length === 5, 'Total scheduled deliveries must equal exactly 5');

  for (const d of delivRes.rows) {
    assert(d.status === 'scheduled', `Delivery ${d.delivery_id} must have status 'scheduled'`);
    assert(Number(d.attempt_count) === 0, `Delivery ${d.delivery_id} must have 0 attempts`);
    assert(d.recipient_email.endsWith('@example.com'), `Recipient ${d.recipient_id} must use @example.com domain`);
  }
  console.log('  ✅ Database audit passed: 5 deliveries verified across 2 campaigns.');
  console.log('     All recipients verified as @example.com test addresses.');
  console.log('     All deliveries verified using ReachInbox QA Ethereal SMTP sender.\n');

  // ===========================================================================
  // STEP 3: Canonical Reconciliation of Missing QA Deliveries into BullMQ
  // ===========================================================================
  console.log('STEP 3: Enqueueing QA Deliveries via Canonical Reconciliation...');
  console.log(SUB_SEP);

  const reconResult: ScheduledReconciliationResult = await reconcileScheduledDeliveries(db, emailQueue);
  console.log(`  Reconciliation checked: ${reconResult.checked}`);
  console.log(`  Reconciliation enqueued: ${reconResult.enqueued}`);
  console.log(`  Reconciliation alreadyQueued: ${reconResult.alreadyQueued}`);

  assert(reconResult.checked === 5, 'Must have checked exactly 5 scheduled deliveries');
  assert(
    reconResult.enqueued + reconResult.alreadyQueued === 5,
    'All 5 deliveries must be either enqueued or already queued'
  );

  for (const d of reconResult.deliveries) {
    console.log(`    -> Job ${d.jobId}: status=${d.status}, delayMs=${d.delayMs}`);
    assert(
      d.status === 'enqueued' || d.status === 'already_queued',
      `Delivery ${d.deliveryId} must be reported as 'enqueued' or 'already_queued'`
    );
    assert(d.jobId.startsWith('campaign_'), `Job ID must follow canonical pattern`);
  }
  console.log('  ✅ 5 QA deliveries verified present in BullMQ.\n');

  // ===========================================================================
  // STEP 4: Idempotency & Duplicate Prevention Verification
  // ===========================================================================
  console.log('STEP 4: Verifying Idempotency (Second Pass Reconciliation)...');
  console.log(SUB_SEP);

  const secondPassResult = await reconcileScheduledDeliveries(db, emailQueue);
  console.log(`  Second pass checked: ${secondPassResult.checked}`);
  console.log(`  Second pass enqueued: ${secondPassResult.enqueued}`);
  console.log(`  Second pass alreadyQueued: ${secondPassResult.alreadyQueued}`);

  assert(secondPassResult.checked === 5, 'Second pass checked exactly 5 deliveries');
  assert(secondPassResult.enqueued === 0, 'Second pass must enqueue ZERO new jobs');
  assert(secondPassResult.alreadyQueued === 5, 'Second pass must report all 5 as alreadyQueued');
  console.log('  ✅ Idempotency confirmed: Zero duplicate jobs created on repeated sweep.\n');

  // ===========================================================================
  // STEP 5: Independent BullMQ Queue & PostgreSQL Consistency Audit
  // ===========================================================================
  console.log('STEP 5: Independent Verification of Final Queue State...');
  console.log(SUB_SEP);

  const [waitingCount, delayedCount, activeCount, failedCount, completedCount] =
    await Promise.all([
      emailQueue.getWaitingCount(),
      emailQueue.getDelayedCount(),
      emailQueue.getActiveCount(),
      emailQueue.getFailedCount(),
      emailQueue.getCompletedCount(),
    ]);

  console.log(`  BullMQ Queue Counts:`);
  console.log(`    Waiting:   ${waitingCount}`);
  console.log(`    Delayed:   ${delayedCount}`);
  console.log(`    Active:    ${activeCount}`);
  console.log(`    Failed:    ${failedCount}`);
  console.log(`    Completed: ${completedCount}`);

  assert(activeCount === 0, 'Active jobs must be 0 (no email worker running)');
  assert(failedCount === 0, 'Failed jobs must be 0');
  assert(completedCount === 0, 'Completed jobs must be 0');
  assert(
    waitingCount + delayedCount === 5,
    `Total pending jobs (waiting + delayed) must equal exactly 5 (got ${waitingCount + delayedCount})`
  );

  // Inspect all 5 jobs in BullMQ
  const jobs = await emailQueue.getJobs(['waiting', 'delayed']);
  assert(jobs.length === 5, 'Must retrieve exactly 5 jobs from BullMQ');

  console.log('\n  Job Details in BullMQ:');
  const validCampaignIds = new Set([EXPECTED_CAMPAIGN_1, EXPECTED_CAMPAIGN_2]);

  for (const job of jobs) {
    const jobData = job.data as EmailJobPayload;
    const jobState = await job.getState();
    console.log(`    Job ID: ${job.id}`);
    console.log(`      Campaign: ${jobData.campaignId}`);
    console.log(`      Recipient: ${jobData.recipientId}`);
    console.log(`      Delivery: ${jobData.deliveryId}`);
    console.log(`      State: ${jobState}, Delay: ${job.delay}ms`);

    assert(validCampaignIds.has(jobData.campaignId), `Job ${job.id} must belong to one of the QA campaigns`);
    assert(job.id === `campaign_${jobData.campaignId}_${jobData.recipientId}`, 'Job ID matches canonical identity');

    // Verify corresponding delivery record in PostgreSQL
    const delCheck = await db.query(
      'SELECT id, status, campaign_id, recipient_id FROM email_deliveries WHERE id = $1',
      [jobData.deliveryId]
    );
    assert(delCheck.rows.length === 1, `Delivery ${jobData.deliveryId} exists in PostgreSQL`);
    assert(delCheck.rows[0].status === 'scheduled', `Delivery status is 'scheduled'`);
    assert(delCheck.rows[0].campaign_id === jobData.campaignId, `Campaign ID matches`);
    assert(delCheck.rows[0].recipient_id === jobData.recipientId, `Recipient ID matches`);
  }

  // Verify delivery_outbox records
  const outboxCheck = await db.query(
    `SELECT deduplication_key, status, dispatched_at FROM delivery_outbox
     WHERE deduplication_key LIKE 'campaign_%'
     ORDER BY created_at ASC`
  );
  console.log(`\n  Delivery Outbox Records: ${outboxCheck.rows.length} rows`);
  for (const ob of outboxCheck.rows) {
    assert(ob.status === 'dispatched', `Outbox record ${ob.deduplication_key} must have status 'dispatched'`);
    assert(ob.dispatched_at !== null, `Outbox record ${ob.deduplication_key} has dispatched_at timestamp`);
  }
  console.log('  ✅ PostgreSQL and BullMQ consistency verified 100%.\n');

  // ===========================================================================
  // STEP 6: Worker & Inline Worker Configuration Verification
  // ===========================================================================
  console.log('STEP 6: Worker Process and Safety Configuration Check...');
  console.log(SUB_SEP);

  const inlineWorkerConfig = process.env.ENABLE_INLINE_WORKER;
  console.log(`  process.env.ENABLE_INLINE_WORKER: "${inlineWorkerConfig}"`);
  assert(inlineWorkerConfig === 'false', 'ENABLE_INLINE_WORKER must be "false"');
  console.log('  ✅ Confirmed: Inline worker disabled.');

  console.log('\n' + SEP);
  console.log('  QUEUE RECONCILIATION RESULT: ALL CHECKS PASSED');
  console.log('  FINAL VERDICT: SAFE TO START');
  console.log(SEP + '\n');
}

main()
  .then(async () => {
    await emailQueue.close();
    await db.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n❌ RECONCILIATION FAILED:', err);
    try { await emailQueue.close(); } catch (_) {}
    try { await db.end(); } catch (_) {}
    process.exit(1);
  });
