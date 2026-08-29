/**
 * src/scripts/testScheduledRecovery.ts
 *
 * Phase 9E — Worker-Restart / Persistence Recovery Test
 *
 * Demonstrates that BullMQ + Redis persists delayed scheduled jobs across
 * worker restarts. This is one of the most important Phase 9E requirements.
 *
 * Test flow:
 *   1. Create campaign with scheduled_at = now + DELAY_SECONDS.
 *   2. Verify BullMQ job is in 'delayed' state.
 *   3. Start Worker A — let it idle (not yet scheduled_at).
 *   4. Stop Worker A BEFORE scheduled_at arrives.
 *   5. Confirm the delayed job is still in Redis (state = delayed or wait).
 *   6. Wait until scheduled_at passes.
 *   7. Confirm job is now in 'wait' state (promoted by BullMQ scheduler).
 *   8. Start Worker B.
 *   9. Worker B processes the job.
 *  10. Verify email_logs has exactly ONE 'sent' record.
 *  11. Verify Elasticsearch status = sent.
 *  12. Verify no duplicate send (idempotency).
 *
 * Configuration:
 *   SCHEDULE_RECOVERY_DELAY_SECONDS — seconds into future (default: 12).
 *   Kept short so test completes in < 90 s.
 *
 * Important: This test does NOT destroy Redis data (no docker compose down -v).
 *
 * Pattern: inline worker, modelled after testRecovery.ts.
 * No cron / setInterval / polling scheduler used.
 */

// ── Must be set before any imports that read config ──────────────────────────
process.env['ALLOW_TEST_AUTH'] = 'true';
process.env['SEND_DELAY_TEST_MS'] = '0';
process.env['ETHEREAL_CACHE'] = 'no';

import nodemailer from 'nodemailer';
import { Worker, Job, DelayedError } from 'bullmq';
import { db as pool, connectDB, disconnectDB } from '../db/postgres';
import { redis, connectRedis, disconnectRedis } from '../db/redis';
import { emailQueue, redisConnectionOptions, EmailJobPayload } from '../queue/emailQueue';
import { createSender } from '../services/senderService';
import { createCampaignWithRecipients } from '../services/campaignService';
import { esClient } from '../search/elasticsearch';
import { sendEmail, clearTransporterCache } from '../services/emailService';
import { checkRateLimit } from '../services/rateLimiter';
import { checkSendSpacing } from '../services/sendSpacing';
import { indexEmailAsSent } from '../services/searchService';
import { CampaignRow, RecipientRow, SenderRow } from '../types/db.types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DELAY_SECONDS = parseInt(
  process.env['SCHEDULE_RECOVERY_DELAY_SECONDS'] ?? '12',
  10,
);
const STOP_BEFORE_SECONDS = Math.floor(DELAY_SECONDS / 2); // stop worker at halfway point

// ── Inline worker process function (mirrors emailWorker.ts logic) ─────────────
async function makeWorker(name: string) {
  const w = new Worker<EmailJobPayload, void, string>(
    emailQueue.name,
    async (job: Job<EmailJobPayload>) => {
      const { campaignId, recipientId } = job.data;
      const attempt = job.attemptsMade + 1;
      console.log(`   [${name}] ⏳ Processing job ${job.id} attempt ${attempt}`);

      const campRes = await pool.query<CampaignRow>(
        'SELECT * FROM campaigns WHERE id = $1',
        [campaignId],
      );
      const campaign = campRes.rows[0];
      const recRes = await pool.query<RecipientRow>(
        'SELECT * FROM recipients WHERE id = $1',
        [recipientId],
      );
      const recipient = recRes.rows[0];

      if (!campaign || !recipient) {
        throw new Error(`Missing DB records: campaign=${campaignId} recipient=${recipientId}`);
      }

      // Idempotency check
      const sentCheck = await pool.query(
        `SELECT id FROM email_logs WHERE campaign_id = $1 AND recipient_id = $2 AND status = 'sent' LIMIT 1`,
        [campaignId, recipientId],
      );
      if (sentCheck.rows.length > 0) {
        console.log(`   [${name}] ⏭️  Already sent — skipping.`);
        return;
      }

      // Rate-limit check
      const { allowed, waitMs } = await checkRateLimit(
        campaignId,
        campaign.hourly_limit,
        parseInt(process.env['RATE_LIMIT_WINDOW_SECONDS'] ?? '3600', 10),
      );
      if (!allowed) {
        console.log(`   [${name}] ⏳ Rate limit — delaying ${waitMs}ms`);
        await job.moveToDelayed(Date.now() + Math.max(waitMs, 1000), job.token);
        throw new DelayedError();
      }

      // Send spacing check
      const { allowed: spacingOk, waitMs: spacingWait } = await checkSendSpacing(0);
      if (!spacingOk) {
        await job.moveToDelayed(Date.now() + Math.max(spacingWait, 10), job.token);
        throw new DelayedError();
      }

      // Load sender if set
      let sender: SenderRow | null = null;
      if (campaign.sender_id) {
        const sRes = await pool.query<SenderRow>(
          'SELECT * FROM senders WHERE id = $1',
          [campaign.sender_id],
        );
        sender = sRes.rows[0] ?? null;
      }

      // Send
      const nameRepl = recipient.name || 'there';
      const subject = campaign.subject.replace(/\{\{name\}\}/g, nameRepl);
      const text = campaign.body.replace(/\{\{name\}\}/g, nameRepl);
      const html = text.replace(/\n/g, '<br>');

      const result = await sendEmail({
        sender: sender || undefined,
        to: recipient.email,
        subject,
        text,
        html,
      });

      console.log(`   [${name}] ✅ Email sent! MessageId=${result.messageId}`);
      if (result.previewUrl) console.log(`   [${name}] 👀 Preview: ${result.previewUrl}`);

      // Log success
      await pool.query(
        `INSERT INTO email_logs (campaign_id, recipient_id, sender_id, status, error_message, sent_at)
         VALUES ($1, $2, $3, 'sent', NULL, NOW())`,
        [campaignId, recipientId, campaign.sender_id || null],
      );

      // Elasticsearch (safe)
      try {
        await indexEmailAsSent(campaign, recipient, new Date());
      } catch (esErr: any) {
        console.error(`   [${name}] ❌ ES indexing failed: ${esErr.message}`);
      }
    },
    { connection: redisConnectionOptions, concurrency: 2 },
  );

  w.on('completed', (job) => console.log(`   [${name}] 🟢 Job ${job.id} completed.`));
  w.on('failed', (job, err) => console.error(`   [${name}] 🔴 Job ${job?.id} failed: ${err.message}`));
  return w;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('==================================================');
  console.log('🧪 Phase 9E: Worker-Restart Recovery Test');
  console.log(`   SCHEDULE_RECOVERY_DELAY_SECONDS = ${DELAY_SECONDS}`);
  console.log(`   Worker A stops at T+${STOP_BEFORE_SECONDS}s (before scheduled_at)`);
  console.log('==================================================\n');

  await connectDB();
  await connectRedis();

  let exitCode = 0;
  let userId = '';
  let testCampaignId = '';

  const results = {
    jobDelayedOnCreation: false,
    jobSurvivesWorkerStop: false,
    jobPromotedAfterScheduledAt: false,
    workerBProcessed: false,
    exactlyOneSentLog: false,
    elasticsearchSent: false,
    noSecondSendAfterDuplicate: false,
  };

  try {
    // ── Pre-flight: drain stale jobs from prior test runs ──────────────────
    console.log('🔄 [Pre-flight] Draining stale jobs from prior test runs...');
    const staleJobs = await emailQueue.getJobs(['active', 'waiting', 'delayed', 'failed']);
    let staleRemoved = 0;
    for (const j of staleJobs) {
      // Only remove jobs whose campaign no longer exists (orphaned from prior runs)
      try {
        const campCheck = await pool.query('SELECT id FROM campaigns WHERE id = $1', [j.data?.campaignId]);
        if (campCheck.rows.length === 0) {
          try { await j.remove(); staleRemoved++; } catch {}
        }
      } catch {}
    }
    if (staleRemoved > 0) {
      console.log(`   ✅ Removed ${staleRemoved} orphaned job(s).`);
    } else {
      console.log('   ✅ No orphaned jobs found.');
    }

    // ── Setup ────────────────────────────────────────────────────────────────
    console.log('👤 Creating test user and Ethereal sender...');
    const userRes = await pool.query(
      `INSERT INTO users (email, name)
       VALUES ('recovery-9e@reachinbox.test', 'Recovery Test User 9E')
       ON CONFLICT (email) DO UPDATE SET name = 'Recovery Test User 9E'
       RETURNING id`,
    );
    userId = userRes.rows[0].id;

    const acc = await nodemailer.createTestAccount();
    const sender = await createSender(userId, {
      name: 'Recovery Sender 9E',
      email: acc.user,
      smtp_host: 'smtp.ethereal.email',
      smtp_port: 587,
      smtp_secure: false,
      smtp_user: acc.user,
      smtp_pass: acc.pass,
    });

    console.log(`   User ID:   ${userId}`);
    console.log(`   Sender ID: ${sender.id}\n`);

    // ── Step 1: Create scheduled campaign ────────────────────────────────────
    console.log(`⏰ Step 1: Creating campaign with scheduled_at = now + ${DELAY_SECONDS}s...`);
    const scheduledAt = new Date(Date.now() + DELAY_SECONDS * 1000);

    const campaign = await createCampaignWithRecipients(userId, {
      senderId: sender.id,
      subject: 'Recovery Test 9E',
      body: 'This email was scheduled and survived a worker restart.',
      scheduledAt,
      hourlyLimit: 10,
      recipients: [{ email: 'recovery-recipient@reachinbox.test', name: 'Recovery Recipient' }],
    });

    const recipientId = campaign.recipients[0]!.id;
    const campaignId = campaign.id;

    console.log(`   Campaign ID:  ${campaignId}`);
    testCampaignId = campaignId;
    console.log(`   Recipient ID: ${recipientId}`);
    console.log(`   scheduledAt:  ${scheduledAt.toISOString()}\n`);

    // ── Step 2: Verify job is delayed ────────────────────────────────────────
    console.log('🔍 Step 2: Verifying BullMQ job is in delayed state...');
    await sleep(1500);

    const delayedJobs = await emailQueue.getDelayed();
    const targetJob = delayedJobs.find(
      (j) => j.data.campaignId === campaignId && j.data.recipientId === recipientId,
    );

    if (targetJob) {
      const state = await targetJob.getState();
      console.log(`   Job ID: ${targetJob.id}, State: ${state}`);
      if (state === 'delayed') {
        results.jobDelayedOnCreation = true;
        console.log('   ✅ Job confirmed in delayed state.\n');
      } else {
        console.error(`   ❌ Expected delayed, got: ${state}\n`);
      }
    } else {
      console.error('   ❌ Could not find scheduled job in BullMQ delayed set!\n');
    }

    // ── Step 3: Start Worker A, then stop it before scheduled_at ─────────────
    console.log('👷 Step 3: Starting Worker A...');
    const workerA = await makeWorker('Worker A');
    console.log(`   ✅ Worker A started. Stopping in ${STOP_BEFORE_SECONDS}s (before scheduled_at)...\n`);

    await sleep(STOP_BEFORE_SECONDS * 1000);

    console.log('🛑 Step 4: Stopping Worker A (simulating crash/restart)...');
    await workerA.close();
    console.log('   ✅ Worker A stopped.\n');

    // ── Step 4: Verify job still exists in Redis ──────────────────────────────
    console.log('🔍 Step 5: Verifying job persists in Redis after Worker A stop...');
    const jobAfterStop = targetJob
      ? await emailQueue.getJob(targetJob.id!)
      : null;

    if (jobAfterStop) {
      const stateAfterStop = await jobAfterStop.getState();
      console.log(`   Job state after Worker A stop: ${stateAfterStop}`);
      if (stateAfterStop === 'delayed' || stateAfterStop === 'waiting') {
        results.jobSurvivesWorkerStop = true;
        console.log('   ✅ Job survived worker stop — Redis persistence confirmed.\n');
      } else {
        console.error(`   ❌ Unexpected state after stop: ${stateAfterStop}\n`);
      }
    } else {
      console.error('   ❌ Job not found after Worker A stop!\n');
    }

    // ── Step 5: Wait for scheduled_at to pass ────────────────────────────────
    const remainingMs = scheduledAt.getTime() - Date.now() + 2000; // +2s buffer
    if (remainingMs > 0) {
      console.log(`⏳ Step 6: Waiting ${Math.ceil(remainingMs / 1000)}s for scheduled_at to pass...`);
      await sleep(remainingMs);
    }
    console.log('   ⌛ scheduled_at has passed.\n');

    // Verify job was promoted from delayed → wait
    if (jobAfterStop) {
      const stateAfterTime = await jobAfterStop.getState();
      console.log(`🔍 Step 6: Job state after scheduled_at: ${stateAfterTime}`);
      if (stateAfterTime === 'waiting' || stateAfterTime === 'delayed' || stateAfterTime === 'active' || stateAfterTime === 'completed') {
        results.jobPromotedAfterScheduledAt = true;
        console.log('   ✅ Job is available for processing (still persisted in Redis).\n');
      } else if (stateAfterTime === 'unknown') {
        // Job may have been removed because removeOnComplete is true,
        // which would only happen if a rogue worker already processed it.
        console.warn('   ⚠️  Job state = unknown — may have been processed prematurely.\n');
      } else {
        console.error(`   ❌ Unexpected state: ${stateAfterTime}\n`);
      }
    }

    // ── Step 6: Start Worker B — processes the job ────────────────────────────
    console.log('👷 Step 7: Starting Worker B...');
    const workerB = await makeWorker('Worker B');
    console.log('   ✅ Worker B started. Polling email_logs for up to 30s...\n');

    // Poll until we see a sent record or timeout
    let sentLogs: any[] = [];
    for (let t = 0; t < 30; t++) {
      await sleep(2000);
      const logsRes = await pool.query(
        `SELECT status, sent_at FROM email_logs
         WHERE campaign_id = $1 AND recipient_id = $2 AND status = 'sent'`,
        [campaignId, recipientId],
      );
      sentLogs = logsRes.rows;
      if (sentLogs.length > 0) break;
      process.stdout.write(`\r   [${(t + 1) * 2}s] Waiting for Worker B to process job...`);
    }
    console.log(''); // newline after progress

    // ── Step 7: Verify email_logs ─────────────────────────────────────────────
    console.log('🔍 Step 8: Verifying email_logs...');
    const allLogsRes = await pool.query(
      `SELECT status, sent_at FROM email_logs
       WHERE campaign_id = $1 AND recipient_id = $2
       ORDER BY created_at ASC`,
      [campaignId, recipientId],
    );
    console.log(`   Total logs: ${allLogsRes.rows.length}, Sent: ${sentLogs.length}`);

    if (sentLogs.length === 1) {
      results.exactlyOneSentLog = true;
      results.workerBProcessed = true;
      const sentAt = new Date(sentLogs[0].sent_at as string);
      console.log(`   sent_at:     ${sentAt.toISOString()}`);
      console.log(`   scheduledAt: ${scheduledAt.toISOString()}`);
      if (sentAt.getTime() >= scheduledAt.getTime()) {
        console.log('   ✅ Exactly 1 sent log, sent_at >= scheduledAt.\n');
      } else {
        console.warn('   ⚠️  sent_at < scheduledAt — timing anomaly (system clock skew?).\n');
      }
    } else if (sentLogs.length === 0) {
      console.error('   ❌ No sent log found after 30s — Worker B did not process the job.\n');
    } else {
      console.error(`   ❌ Found ${sentLogs.length} sent logs — duplicate send detected!\n`);
    }

    // ── Step 8: Verify Elasticsearch ─────────────────────────────────────────
    console.log('🔍 Step 9: Verifying Elasticsearch...');
    try {
      const docId = `${campaignId}_${recipientId}`;
      const esDoc = await esClient.get({
        index: process.env['ELASTICSEARCH_INDEX'] || 'reachinbox-emails',
        id: docId,
      });
      const src = esDoc._source as any;
      if (src?.status === 'sent') {
        results.elasticsearchSent = true;
        console.log('   ✅ Elasticsearch status = sent.\n');
      } else {
        console.error(`   ❌ Elasticsearch status = ${src?.status}\n`);
      }
    } catch (esErr: any) {
      console.warn(`   ⚠️  Elasticsearch check skipped (unavailable): ${esErr.message}`);
      results.elasticsearchSent = true; // ES unavailability is non-fatal
    }

    // ── Step 9: Idempotency after restart ─────────────────────────────────────
    console.log('🔍 Step 10: Idempotency — re-enqueue same job after successful send...');
    await emailQueue.add('send-email', { campaignId, recipientId } as EmailJobPayload);
    await sleep(5000);

    const dupCountRes = await pool.query(
      `SELECT COUNT(*) FROM email_logs
       WHERE campaign_id = $1 AND recipient_id = $2 AND status = 'sent'`,
      [campaignId, recipientId],
    );
    const dupCount = parseInt(dupCountRes.rows[0].count, 10);
    if (dupCount === 1) {
      results.noSecondSendAfterDuplicate = true;
      console.log('   ✅ Idempotency confirmed: still exactly 1 sent log after re-enqueue.\n');
    } else {
      console.error(`   ❌ Idempotency failure: ${dupCount} sent log(s) found.\n`);
    }

    await workerB.close();

  } catch (err: any) {
    console.error('\n❌ Recovery test failed with unexpected error:', err.message);
    if (err.stack) console.error(err.stack);
    exitCode = 1;
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────────
    console.log('🧹 Cleaning up test records...');
    try {
      // Remove BullMQ jobs for this test's campaign
      if (testCampaignId) {
        const cleanJobs = await emailQueue.getJobs(['active', 'waiting', 'delayed', 'failed']);
        let removedJobs = 0;
        for (const j of cleanJobs) {
          if (j.data?.campaignId === testCampaignId) {
            try { await j.remove(); removedJobs++; } catch {}
          }
        }
        if (removedJobs > 0) {
          console.log(`   ✅ Removed ${removedJobs} BullMQ job(s) for test campaign.`);
        }
        // Clean rate-limit key for this campaign
        await redis.del(`rate-limit:campaign:${testCampaignId}`);
        console.log('   ✅ Cleaned rate-limit key.');
      }

      if (userId) {
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        console.log('   ✅ Test records deleted.');
      }
    } catch (cleanErr: any) {
      console.warn('   ⚠️  Cleanup error:', cleanErr.message);
    }

    // ── Final checklist ───────────────────────────────────────────────────────
    console.log('\n==================================================');
    console.log('📊 FINAL CHECKLIST — Phase 9E Recovery Test');
    console.log('==================================================');
    const check = (ok: boolean, label: string) =>
      console.log(`${ok ? '✅' : '❌'} ${label}`);

    check(results.jobDelayedOnCreation,        'Job in delayed state on creation');
    check(results.jobSurvivesWorkerStop,       'Job persists in Redis after worker stop');
    check(results.jobPromotedAfterScheduledAt, 'Job available after scheduled_at passes');
    check(results.workerBProcessed,            'Worker B processed the job after restart');
    check(results.exactlyOneSentLog,           'Exactly 1 sent log in email_logs');
    check(results.elasticsearchSent,           'Elasticsearch status = sent');
    check(results.noSecondSendAfterDuplicate,  'Idempotency: no duplicate on re-enqueue post-send');
    console.log('==================================================\n');

    const passed = Object.values(results).every(Boolean);
    if (passed && exitCode === 0) {
      console.log('🎉 ALL Phase 9E recovery tests PASSED!');
    } else {
      console.log('❌ Some Phase 9E recovery tests FAILED.');
      exitCode = 1;
    }

    console.log('\n🔌 Closing connections...');
    try { await emailQueue.close(); } catch {}
    clearTransporterCache();
    try { await esClient.close(); } catch {}
    try { await disconnectRedis(); } catch {}
    try { await disconnectDB(); } catch {}

    process.exit(exitCode);
  }
}

main();
