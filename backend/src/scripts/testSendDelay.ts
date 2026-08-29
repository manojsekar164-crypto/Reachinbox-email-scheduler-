process.env.SEND_DELAY_TEST_MS = '500'; // Override for test
process.env.ETHEREAL_CACHE = 'no'; // Bypass Nodemailer process-level account cache

import { db as pool, connectDB, disconnectDB } from '../db/postgres';
import { emailQueue } from '../queue/emailQueue';
import { worker as emailWorker } from '../workers/emailWorker';
import { clearTransporterCache } from '../services/emailService';
import { disconnectRedis } from '../db/redis';
import { esClient } from '../search/elasticsearch';
import { checkSendSpacing } from '../services/sendSpacing';
import { createSender } from '../services/senderService';
import { createCampaignWithRecipients } from '../services/campaignService';
import nodemailer from 'nodemailer';
import { redis } from '../db/redis';

/**
 * src/scripts/testSendDelay.ts
 *
 * Verification suite for Phase 9C: Minimum Delay Between Individual Email Sends.
 */

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log('🧪 Starting Phase 9C: Minimum Send Delay Verification Suite...\n');

  let userId = '';
  const testResults = {
    atomicityPass: false,
    basicTimingPass: false,
    concurrentTimingPass: false,
    rateLimitDelayPass: false,
    retryDelayPass: false,
    restartPass: false,
  };

  try {
    // 0. Ensure database connection
    await connectDB();

    // ---------------------------------------------------------------------------
    // TEST 1: REDIS ATOMICITY TEST
    // ---------------------------------------------------------------------------
    console.log('\n--- 1. REDIS ATOMICITY TEST ---');
    // Clear last-send key
    await redis.del('email-send:global:last-send');

    // Call checkSendSpacing concurrently
    const results = await Promise.all([
      checkSendSpacing(500),
      checkSendSpacing(500),
      checkSendSpacing(500),
      checkSendSpacing(500),
      checkSendSpacing(500),
    ]);

    console.log('   Results:', results.map(r => `allowed=${r.allowed}, waitMs=${r.waitMs}`));
    const allowedCount = results.filter(r => r.allowed).length;
    const blockedCount = results.filter(r => !r.allowed).length;

    if (allowedCount === 1 && blockedCount === 4) {
      testResults.atomicityPass = true;
      console.log('   ✅ Pass: Exactly one task was allowed; others were delayed.');
    } else {
      console.error(`   ❌ Fail: Expected 1 allowed and 4 blocked, got ${allowedCount} allowed and ${blockedCount} blocked.`);
    }

    // ---------------------------------------------------------------------------
    // TEST 2: BASIC TIMING TEST
    // ---------------------------------------------------------------------------
    console.log('\n--- 2. BASIC TIMING TEST ---');
    // Set up user, sender, campaign with 3 recipients
    const userRes = await pool.query(
      `INSERT INTO users (email, name) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET name = $2 RETURNING id`,
      [`test-senddelay-u1-${Date.now()}@reachinbox.test`, 'Send Delay User']
    );
    userId = userRes.rows[0].id;

    // Ethereal SMTP sender
    console.log('   Creating Ethereal account...');
    const acc = await nodemailer.createTestAccount();
    const sender = await createSender(userId, {
      name: 'Delay Sender',
      email: 'delay-sender@reachinbox.test',
      smtp_host: 'smtp.ethereal.email',
      smtp_port: 587,
      smtp_secure: false,
      smtp_user: acc.user,
      smtp_pass: acc.pass,
    });

    const campaign = await createCampaignWithRecipients(userId, {
      senderId: sender.id,
      subject: 'Send Spacing Test',
      body: 'Body text',
      hourlyLimit: 100,
      recipients: [
        { email: 'rec1@reachinbox.test', name: 'Rec 1' },
        { email: 'rec2@reachinbox.test', name: 'Rec 2' },
        { email: 'rec3@reachinbox.test', name: 'Rec 3' },
      ],
    });

    // Clear send key
    await redis.del('email-send:global:last-send');

    console.log('   Adding 3 jobs to the queue sequentially...');
    await emailQueue.add('send-email', { campaignId: campaign.id, recipientId: campaign.recipients[0].id });
    await delay(100);
    await emailQueue.add('send-email', { campaignId: campaign.id, recipientId: campaign.recipients[1].id });
    await delay(100);
    await emailQueue.add('send-email', { campaignId: campaign.id, recipientId: campaign.recipients[2].id });

    // Wait for all to complete
    console.log('   Waiting for sequential jobs to finish...');
    let allDone = false;
    for (let i = 0; i < 75; i++) {
      await delay(1000);
      const logCount = await pool.query(
        `SELECT COUNT(*) FROM email_logs WHERE campaign_id = $1 AND status = 'sent'`,
        [campaign.id]
      );
      if (parseInt(logCount.rows[0].count, 10) === 3) {
        allDone = true;
        break;
      }
    }

    if (!allDone) throw new Error('Sequential jobs did not finish in time.');

    // Fetch logs and check timestamps
    const logsRes = await pool.query(
      `SELECT sent_at FROM email_logs WHERE campaign_id = $1 AND status = 'sent' ORDER BY sent_at ASC`,
      [campaign.id]
    );

    if (logsRes.rows.length === 3) {
      const t1 = new Date(logsRes.rows[0].sent_at).getTime();
      const t2 = new Date(logsRes.rows[1].sent_at).getTime();
      const t3 = new Date(logsRes.rows[2].sent_at).getTime();

      const diff1 = t2 - t1;
      const diff2 = t3 - t2;
      console.log(`   Send timestamps: t1=${t1}, t2=${t2}, t3=${t3}`);
      console.log(`   Diff 1 (t2 - t1): ${diff1}ms (Required: >=500ms)`);
      console.log(`   Diff 2 (t3 - t2): ${diff2}ms (Required: >=500ms)`);

      const tolerance = 60; // timing tolerance for system scheduling
      if (diff1 >= 500 - tolerance && diff2 >= 500 - tolerance) {
        testResults.basicTimingPass = true;
        console.log('   ✅ Pass: Observed send spacing respects minimum delay.');
      } else {
        console.error('   ❌ Fail: Observed spacing was below the configured minimum (500ms).');
      }
    } else {
      console.error(`   ❌ Fail: Expected 3 logs, found ${logsRes.rows.length}`);
    }

    // ---------------------------------------------------------------------------
    // TEST 3: CONCURRENT WORKER TEST
    // ---------------------------------------------------------------------------
    console.log('\n--- 3. CONCURRENT WORKER TIMING TEST ---');
    const campaignConcurrent = await createCampaignWithRecipients(userId, {
      senderId: sender.id,
      subject: 'Concurrent Spacing Test',
      body: 'Concurrent body text',
      hourlyLimit: 100,
      recipients: [
        { email: 'con1@reachinbox.test', name: 'Con 1' },
        { email: 'con2@reachinbox.test', name: 'Con 2' },
        { email: 'con3@reachinbox.test', name: 'Con 3' },
      ],
    });

    await redis.del('email-send:global:last-send');

    console.log('   Adding 3 jobs concurrently...');
    await Promise.all([
      emailQueue.add('send-email', { campaignId: campaignConcurrent.id, recipientId: campaignConcurrent.recipients[0].id }),
      emailQueue.add('send-email', { campaignId: campaignConcurrent.id, recipientId: campaignConcurrent.recipients[1].id }),
      emailQueue.add('send-email', { campaignId: campaignConcurrent.id, recipientId: campaignConcurrent.recipients[2].id }),
    ]);

    console.log('   Waiting for concurrent jobs to finish...');
    allDone = false;
    for (let i = 0; i < 75; i++) {
      await delay(1000);
      const logCount = await pool.query(
        `SELECT COUNT(*) FROM email_logs WHERE campaign_id = $1 AND status = 'sent'`,
        [campaignConcurrent.id]
      );
      if (parseInt(logCount.rows[0].count, 10) === 3) {
        allDone = true;
        break;
      }
    }

    if (!allDone) throw new Error('Concurrent jobs did not finish in time.');

    const logsConcurrent = await pool.query(
      `SELECT sent_at FROM email_logs WHERE campaign_id = $1 AND status = 'sent' ORDER BY sent_at ASC`,
      [campaignConcurrent.id]
    );

    if (logsConcurrent.rows.length === 3) {
      const t1 = new Date(logsConcurrent.rows[0].sent_at).getTime();
      const t2 = new Date(logsConcurrent.rows[1].sent_at).getTime();
      const t3 = new Date(logsConcurrent.rows[2].sent_at).getTime();

      const diff1 = t2 - t1;
      const diff2 = t3 - t2;
      console.log(`   Send timestamps: t1=${t1}, t2=${t2}, t3=${t3}`);
      console.log(`   Diff 1 (t2 - t1): ${diff1}ms (Required: >=500ms)`);
      console.log(`   Diff 2 (t3 - t2): ${diff2}ms (Required: >=500ms)`);

      const tolerance = 60;
      if (diff1 >= 500 - tolerance && diff2 >= 500 - tolerance) {
        testResults.concurrentTimingPass = true;
        console.log('   ✅ Pass: Spacing is maintained under concurrent worker execution.');
      } else {
        console.error('   ❌ Fail: Observed spacing violates the minimum configured delay under concurrent execution.');
      }
    } else {
      console.error(`   ❌ Fail: Expected 3 logs, found ${logsConcurrent.rows.length}`);
    }

    // ---------------------------------------------------------------------------
    // TEST 4: RATE LIMIT + SEND DELAY TEST
    // ---------------------------------------------------------------------------
    console.log('\n--- 4. RATE LIMIT + SEND DELAY TEST ---');
    const campaignRateLimit = await createCampaignWithRecipients(userId, {
      senderId: sender.id,
      subject: 'Rate Limit + Spacing Test',
      body: 'Rate limit body',
      hourlyLimit: 3,
      recipients: [
        { email: 'rl1@reachinbox.test', name: 'RL 1' },
        { email: 'rl2@reachinbox.test', name: 'RL 2' },
        { email: 'rl3@reachinbox.test', name: 'RL 3' },
        { email: 'rl4@reachinbox.test', name: 'RL 4' },
        { email: 'rl5@reachinbox.test', name: 'RL 5' },
      ],
    });

    await redis.del('email-send:global:last-send');

    console.log('   Adding 5 jobs to queue concurrently (with testWindowSeconds: 5)...');
    const rlJobs = [];
    for (let i = 0; i < 5; i++) {
      rlJobs.push(
        await emailQueue.add('send-email', {
          campaignId: campaignRateLimit.id,
          recipientId: campaignRateLimit.recipients[i].id,
          testWindowSeconds: 5, // Rate limit window resets after 5s
        } as any)
      );
    }

    console.log('   Waiting for rate limit + delay jobs to finish...');
    allDone = false;
    for (let i = 0; i < 90; i++) {
      await delay(1000);
      const logCount = await pool.query(
        `SELECT COUNT(*) FROM email_logs WHERE campaign_id = $1 AND status = 'sent'`,
        [campaignRateLimit.id]
      );
      if (parseInt(logCount.rows[0].count, 10) === 5) {
        allDone = true;
        break;
      }
    }

    if (!allDone) throw new Error('Rate limit + delay jobs did not finish.');

    const logsRL = await pool.query(
      `SELECT sent_at FROM email_logs WHERE campaign_id = $1 AND status = 'sent' ORDER BY sent_at ASC`,
      [campaignRateLimit.id]
    );

    if (logsRL.rows.length === 5) {
      const times = logsRL.rows.map((r: any) => new Date(r.sent_at).getTime());
      console.log('   Send times:', times);

      const diff1 = times[1] - times[0];
      const diff2 = times[2] - times[1];
      const diff3 = times[3] - times[2];
      const diff4 = times[4] - times[3];

      console.log(`   Spacing 1 (t2 - t1): ${diff1}ms (Required: >=500ms)`);
      console.log(`   Spacing 2 (t3 - t2): ${diff2}ms (Required: >=500ms)`);
      console.log(`   Spacing 3 (t4 - t3): ${diff3}ms (Required: rate-limited delay)`);
      console.log(`   Spacing 4 (t5 - t4): ${diff4}ms (Required: >=500ms)`);

      const tolerance = 60;
      const spacing12Ok = diff1 >= 500 - tolerance && diff2 >= 500 - tolerance;
      const rateLimitDelayOk = times[3] - times[0] >= 5000 - tolerance; // 4th send delayed by rate limit reset window
      const spacing45Ok = diff4 >= 500 - tolerance;

      if (spacing12Ok && rateLimitDelayOk && spacing45Ok) {
        testResults.rateLimitDelayPass = true;
        console.log('   ✅ Pass: Rate limiting and send spacing are enforced independently.');
      } else {
        console.error('   ❌ Fail: Rate limiting or send spacing rules were violated.');
      }
    } else {
      console.error(`   ❌ Fail: Expected 5 logs, found ${logsRL.rows.length}`);
    }

    // ---------------------------------------------------------------------------
    // TEST 5: RETRY + SEND DELAY TEST
    // ---------------------------------------------------------------------------
    console.log('\n--- 5. RETRY + SEND DELAY TEST ---');
    const campaignRetry = await createCampaignWithRecipients(userId, {
      senderId: sender.id,
      subject: 'Retry Spacing Test',
      body: 'Retry body',
      hourlyLimit: 100,
      recipients: [
        { email: 'retry-delay@reachinbox.test', name: 'Retry Rec' },
      ],
    });

    await redis.del('email-send:global:last-send');

    // Force delay wait: set last-send key to `now`
    const nowTime = Date.now();
    await redis.set('email-send:global:last-send', String(nowTime));

    console.log('   Adding failing job with simulateFailure: true...');
    await emailQueue.add('send-email', {
      campaignId: campaignRetry.id,
      recipientId: campaignRetry.recipients[0].id,
      simulateFailure: true,
    } as any);

    console.log('   Waiting for retry job to complete...');
    allDone = false;
    for (let i = 0; i < 75; i++) {
      await delay(1000);
      const logCount = await pool.query(
        `SELECT COUNT(*) FROM email_logs WHERE campaign_id = $1 AND recipient_id = $2 AND status = 'sent'`,
        [campaignRetry.id, campaignRetry.recipients[0].id]
      );
      if (parseInt(logCount.rows[0].count, 10) >= 1) {
        allDone = true;
        break;
      }
    }

    if (!allDone) throw new Error('Retry job did not complete.');

    // Verify logs
    const retryLogs = await pool.query(
      `SELECT status, sent_at FROM email_logs WHERE campaign_id = $1 AND recipient_id = $2 ORDER BY created_at ASC`,
      [campaignRetry.id, campaignRetry.recipients[0].id]
    );

    console.log(`   Found ${retryLogs.rows.length} log entries for retry recipient.`);
    if (retryLogs.rows.length >= 2) {
      const firstFailed = retryLogs.rows[0].status === 'failed';
      const secondSent = retryLogs.rows[retryLogs.rows.length - 1].status === 'sent';
      const sentTime = new Date(retryLogs.rows[retryLogs.rows.length - 1].sent_at).getTime();

      const diff = sentTime - nowTime;
      console.log(`   Time from test start to successful retry: ${diff}ms (Required: >=500ms)`);

      const tolerance = 60;
      if (firstFailed && secondSent && diff >= 500 - tolerance) {
        testResults.retryDelayPass = true;
        console.log('   ✅ Pass: Retry failed initially, logged failure, retried, and succeeded while respecting spacing.');
      } else {
        console.error('   ❌ Fail: Retry timing or log validation failed.');
      }
    } else {
      console.error(`   ❌ Fail: Expected at least 2 logs (failed, sent), got ${retryLogs.rows.length}`);
    }

    // ---------------------------------------------------------------------------
    // TEST 6: RESTART TEST
    // ---------------------------------------------------------------------------
    console.log('\n--- 6. RESTART TEST ---');
    console.log('   Pausing worker...');
    await emailWorker.pause();

    const campaignRestart = await createCampaignWithRecipients(userId, {
      senderId: sender.id,
      subject: 'Restart Test',
      body: 'Restart body',
      hourlyLimit: 100,
      recipients: [
        { email: 'rest1@reachinbox.test', name: 'Rest 1' },
        { email: 'rest2@reachinbox.test', name: 'Rest 2' },
      ],
    });

    await redis.del('email-send:global:last-send');

    console.log('   Adding 2 jobs while worker is paused...');
    const restJob1 = await emailQueue.add('send-email', { campaignId: campaignRestart.id, recipientId: campaignRestart.recipients[0].id });
    const restJob2 = await emailQueue.add('send-email', { campaignId: campaignRestart.id, recipientId: campaignRestart.recipients[1].id });

    await delay(2000);
    const restState1 = await emailQueue.getJobState(restJob1.id!);
    const restState2 = await emailQueue.getJobState(restJob2.id!);
    console.log(`   Job states while paused: [1] ${restState1}, [2] ${restState2}`);

    if (restState1 !== 'completed' && restState2 !== 'completed') {
      console.log('   ✅ Worker is paused: Jobs are successfully queued but not processed.');
    } else {
      throw new Error('Jobs processed while worker was paused!');
    }

    console.log('   Resuming worker...');
    await emailWorker.resume();

    console.log('   Waiting for jobs to complete...');
    allDone = false;
    for (let i = 0; i < 75; i++) {
      await delay(1000);
      const logCount = await pool.query(
        `SELECT COUNT(*) FROM email_logs WHERE campaign_id = $1 AND status = 'sent'`,
        [campaignRestart.id]
      );
      if (parseInt(logCount.rows[0].count, 10) === 2) {
        allDone = true;
        break;
      }
    }

    if (!allDone) throw new Error('Restart jobs did not complete.');

    const logsRestart = await pool.query(
      `SELECT sent_at FROM email_logs WHERE campaign_id = $1 AND status = 'sent' ORDER BY sent_at ASC`,
      [campaignRestart.id]
    );

    if (logsRestart.rows.length === 2) {
      const t1 = new Date(logsRestart.rows[0].sent_at).getTime();
      const t2 = new Date(logsRestart.rows[1].sent_at).getTime();
      const diff = t2 - t1;
      console.log(`   Send timestamps after restart: t1=${t1}, t2=${t2}`);
      console.log(`   Diff: ${diff}ms (Required: >=500ms)`);

      const tolerance = 60;
      if (diff >= 500 - tolerance) {
        testResults.restartPass = true;
        console.log('   ✅ Pass: Send delay is correctly respected after worker restart.');
      } else {
        console.error('   ❌ Fail: Send delay was violated after worker restart.');
      }
    } else {
      console.error(`   ❌ Fail: Expected 2 logs, found ${logsRestart.rows.length}`);
    }

  } catch (error: any) {
    console.error('\n❌ Verification test failed:', error);
  } finally {
    console.log('\n🧹 Cleaning up test records...');
    if (userId) {
      try {
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        console.log('   ✅ Database cleaned up.');
      } catch (err: any) {
        console.warn('   ⚠️ Database cleanup failed:', err.message);
      }
    }

    console.log('🧹 Closing worker and queue connections...');
    try {
      await emailWorker.close();
    } catch (err) {
      console.error('Failed to close worker:', err);
    }
    try {
      await emailQueue.close();
    } catch (err) {
      console.error('Failed to close queue:', err);
    }

    console.log('🧹 Disconnecting Redis...');
    try {
      await disconnectRedis();
    } catch (err) {
      console.error('Failed to disconnect Redis:', err);
    }

    console.log('🧹 Closing Elasticsearch connection...');
    try {
      await esClient.close();
    } catch (err) {
      console.error('Failed to close Elasticsearch client:', err);
    }

    console.log('🧹 Clearing transporters cache...');
    clearTransporterCache();

    console.log('🔌 Disconnecting Database...');
    await disconnectDB();

    // Final checklist
    console.log('\n==================================================');
    console.log('📊 FINAL CHECKLIST');
    console.log('==================================================');
    console.log(`${testResults.atomicityPass ? '✅' : '❌'} Redis atomicity test`);
    console.log(`${testResults.basicTimingPass ? '✅' : '❌'} Basic timing test`);
    console.log(`${testResults.concurrentTimingPass ? '✅' : '❌'} Concurrent worker timing test`);
    console.log(`${testResults.rateLimitDelayPass ? '✅' : '❌'} Rate-limit + delay test`);
    console.log(`${testResults.retryDelayPass ? '✅' : '❌'} Retry + delay test`);
    console.log(`${testResults.restartPass ? '✅' : '❌'} Restart test`);
    console.log('==================================================\n');

    process.exit(
      testResults.atomicityPass &&
      testResults.basicTimingPass &&
      testResults.concurrentTimingPass &&
      testResults.rateLimitDelayPass &&
      testResults.retryDelayPass &&
      testResults.restartPass
        ? 0
        : 1
    );
  }
}

main();
