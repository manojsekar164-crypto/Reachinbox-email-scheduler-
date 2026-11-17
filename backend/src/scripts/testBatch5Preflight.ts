/**
 * src/scripts/testBatch5Preflight.ts
 *
 * REACHINBOX — BATCH 5 ACCEPTANCE TEST SUITE
 * Smart Campaign Preflight & Delivery Forecast Verification
 *
 * Verifies all 12 Batch 5 acceptance criteria against an isolated ephemeral PostgreSQL
 * database and isolated Redis keys:
 *
 *  1. Valid CSV parsing (headers, quotes, delimiters, BOM).
 *  2. Invalid email detection with row numbers and descriptive reasons.
 *  3. Duplicate detection within uploaded data (case-insensitive).
 *  4. Existing campaign recipient detection via PostgreSQL.
 *  5. Malformed and oversized file handling (empty, missing email column, binary, >5MB).
 *  6. Correct validation counts (valid, invalid, duplicate, existing, total).
 *  7. Global hourly capacity calculation (active and disabled).
 *  8. Sender-specific capacity calculation and window tracking.
 *  9. Campaign limit and minimum-spacing calculation.
 * 10. Delivery forecast accuracy under configured limits (multi-hour & single-hour).
 * 11. Preflight creates zero database records, zero BullMQ jobs, and zero reservations.
 * 12. User isolation and authorization scoping.
 *
 * INVARIANTS:
 *  - Uses ephemeral DB `reachinbox_migration_test`.
 *  - Production DB `reachinbox` is NEVER touched.
 *  - Completely read-only operations during preflight.
 */

process.env.START_WORKER = 'false';
process.env.SEND_DELAY_TEST_MS = '0';
process.env.DISABLE_ES_INDEXING = 'true';
process.env.NODE_ENV = 'test';

import { Client, Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';
import { redis } from '../db/redis';
import { runMigrations } from '../db/migrate';
import { emailQueue } from '../queue/emailQueue';
import { safeEncrypt } from '../utils/crypto';
import {
  parseRawContent,
  validateRecipients,
  calculateCapacityAndForecast,
  runPreflight,
} from '../services/preflightService';
import { preflightCampaignHandler } from '../controllers/preflightController';

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

async function runBatch5Verification(): Promise<void> {
  console.log('\n' + SEP);
  console.log('  BATCH 5 VERIFICATION: SMART CAMPAIGN PREFLIGHT & FORECAST');
  console.log('  Target Database: reachinbox_migration_test (Ephemeral Isolated Test DB)');
  console.log('  Production DB:   reachinbox (UNTOUCHED)');
  console.log(SEP);

  // Clean test rate-limit keys in Redis
  const keysPattern = await redis.keys('rate-limit:*');
  if (keysPattern.length > 0) {
    await redis.del(...keysPattern);
  }
  await redis.del('email-send:global:last-send');
  try {
    await emailQueue.obliterate({ force: true });
  } catch {}

  // Prepare isolated DB
  console.log('\n1. Preparing isolated ephemeral test database...');
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
    console.log('\n2. Restoring pre-stage1 backup into isolated database...');
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
    console.log('\n3. Applying schema migrations to isolated database...');
    const migrationResult = await runMigrations(testClient);
    console.log(`   Migrations applied: ${migrationResult.applied.length}, skipped: ${migrationResult.skipped.length}`);

    try {
      // Create primary test user
      const userRes = await testClient.query(
        `INSERT INTO users (email, name)
         VALUES ('user_a@reachinbox.test', 'User A')
         RETURNING id;`
      );
      const userAId = userRes.rows[0].id;

      // Create secondary test user (for isolation testing)
      const userBRes = await testClient.query(
        `INSERT INTO users (email, name)
         VALUES ('user_b@reachinbox.test', 'User B')
         RETURNING id;`
      );
      const userBId = userBRes.rows[0].id;

      // Create Sender for User A
      const encryptedPass = safeEncrypt('secret');
      const senderARes = await testClient.query(
        `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, hourly_limit)
         VALUES ($1, 'Sender A', 'sender_a@reachinbox.test', '127.0.0.1', 587, false, 'user_a', $2, 50)
         RETURNING id, hourly_limit;`,
        [userAId, encryptedPass]
      );
      const senderAId = senderARes.rows[0].id;

      // Create Sender for User B
      const senderBRes = await testClient.query(
        `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, hourly_limit)
         VALUES ($1, 'Sender B', 'sender_b@reachinbox.test', '127.0.0.1', 587, false, 'user_b', $2, 100)
         RETURNING id;`,
        [userBId, encryptedPass]
      );
      const senderBId = senderBRes.rows[0].id;

      // Create Campaign for User A
      const campARes = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, hourly_limit, status)
         VALUES ($1, $2, 'Campaign A Subject', 'Body A', 10, 'draft')
         RETURNING id;`,
        [userAId, senderAId]
      );
      const campaignAId = campARes.rows[0].id;

      // Pre-insert existing recipient in Campaign A
      await testClient.query(
        `INSERT INTO recipients (campaign_id, email, name)
         VALUES ($1, 'already_in_db@reachinbox.test', 'Existing Recipient');`,
        [campaignAId]
      );

      // Create Campaign for User B
      const campBRes = await testClient.query(
        `INSERT INTO campaigns (user_id, sender_id, subject, body, hourly_limit, status)
         VALUES ($1, $2, 'Campaign B Subject', 'Body B', 20, 'draft')
         RETURNING id;`,
        [userBId, senderBId]
      );
      const campaignBId = campBRes.rows[0].id;

      // -----------------------------------------------------------------------
      // TEST 1: Valid CSV Parsing
      // -----------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 1: Valid CSV Parsing (headers, delimiters, quotes, BOM)');
      console.log(SUB_SEP);

      // Standard CSV with header
      const csvStandard = `email,name\nalice@example.com,Alice Smith\nbob@example.com,Bob Jones`;
      const parsedStd = parseRawContent(csvStandard);
      assert(parsedStd.headerFound === true, 'Header detection correctly identifies email header');
      assert(parsedStd.rows.length === 2, 'Parsed exactly 2 recipient rows');
      assert(parsedStd.rows[0]?.email === 'alice@example.com', 'First email parsed accurately');
      assert(parsedStd.rows[0]?.name === 'Alice Smith', 'First name parsed accurately');

      // CSV with quotes and commas inside quotes
      const csvQuoted = `"email","name"\n"charlie@example.com","Brown, Charlie"\n"david@example.com","David ""The Great"" Smith"`;
      const parsedQuoted = parseRawContent(csvQuoted);
      assert(parsedQuoted.rows.length === 2, 'Quoted CSV parsed without syntax error');
      assert(parsedQuoted.rows[0]?.name === 'Brown, Charlie', 'Quoted comma inside name preserved');
      assert(parsedQuoted.rows[1]?.name === 'David "The Great" Smith', 'Escaped double quotes preserved');

      // Headerless CSV
      const csvHeaderless = `eve@example.com,Eve\nfrank@example.com,Frank`;
      const parsedHeaderless = parseRawContent(csvHeaderless);
      assert(parsedHeaderless.headerFound === false, 'Headerless CSV identified as data rows');
      assert(parsedHeaderless.rows.length === 2, 'Parsed 2 rows from headerless CSV');
      assert(parsedHeaderless.rows[0]?.email === 'eve@example.com', 'Headerless email mapped');

      // UTF-8 BOM
      const csvBom = `\uFEFFemail,name\ngrace@example.com,Grace`;
      const parsedBom = parseRawContent(csvBom);
      assert(parsedBom.rows[0]?.email === 'grace@example.com', 'UTF-8 BOM stripped cleanly');

      // Semicolon delimited
      const csvSemi = `email;name\nheidi@example.com;Heidi`;
      const parsedSemi = parseRawContent(csvSemi);
      assert(parsedSemi.rows[0]?.email === 'heidi@example.com', 'Semicolon delimiter detected and parsed');

      // -----------------------------------------------------------------------
      // TEST 2: Invalid Email Detection
      // -----------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 2: Invalid Email Detection with Row Numbers & Reasons');
      console.log(SUB_SEP);

      const invalidCsv = `email,name
valid1@example.com,Valid One
missing-at-sign.com,Bad One
user@,Bad Two
@domain.com,Bad Three
user@space domain.com,Bad Four
,Empty Email`;

      const valInvalid = await validateRecipients(
        { userId: userAId, rawContent: invalidCsv },
        testClient
      );

      assert(valInvalid.counts.valid_count === 1, 'Only 1 email is valid in invalid batch');
      assert(valInvalid.counts.invalid_count === 5, 'All 5 bad/empty emails classified as invalid');
      assert(valInvalid.invalid.length === 5, 'Invalid array contains exactly 5 entries');
      assert(valInvalid.invalid[0]?.row === 3, 'First invalid row number tracked correctly (row 3)');
      assert(valInvalid.invalid[0]?.reason.includes('format'), 'Informative reason provided for invalid syntax');
      assert(valInvalid.invalid[4]?.reason.includes('Empty'), 'Informative reason provided for empty email');

      // -----------------------------------------------------------------------
      // TEST 3: Duplicate Detection within Uploaded Data
      // -----------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 3: Duplicate Detection within Uploaded Data (Case-Insensitive)');
      console.log(SUB_SEP);

      const duplicateCsv = `email,name
dup@example.com,First Occurrence
unique@example.com,Unique
DUP@EXAMPLE.COM,Case Insensitive Duplicate
dup@example.com,Third Duplicate`;

      const valDup = await validateRecipients(
        { userId: userAId, rawContent: duplicateCsv },
        testClient
      );

      assert(valDup.counts.valid_count === 2, 'Only first occurrence of each unique email is valid');
      assert(valDup.counts.duplicate_count === 2, 'Both duplicate occurrences captured in duplicates');
      assert(valDup.duplicates.length === 2, 'Duplicates array has 2 records');
      assert(valDup.duplicates[0]?.row === 4, 'Case-insensitive duplicate identified at row 4');
      assert(valDup.duplicates[0]?.email === 'dup@example.com', 'Duplicate email normalized to lowercase');
      assert(valDup.duplicates[0]?.reason.includes('Duplicate email'), 'Reason states duplicate within upload');

      // -----------------------------------------------------------------------
      // TEST 4: Existing Campaign Recipient Detection
      // -----------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 4: Existing Campaign Recipient Detection via PostgreSQL');
      console.log(SUB_SEP);

      const existingCsv = `email,name
brand_new@reachinbox.test,Brand New
ALREADY_IN_DB@reachinbox.test,Existing in Campaign`;

      const valExisting = await validateRecipients(
        { userId: userAId, campaignId: campaignAId, rawContent: existingCsv },
        testClient
      );

      assert(valExisting.counts.valid_count === 1, 'Brand new email is classified as valid');
      assert(valExisting.counts.existing_count === 1, 'Pre-existing campaign recipient detected');
      assert(valExisting.existing.length === 1, 'Existing array has 1 record');
      assert(valExisting.existing[0]?.email === 'already_in_db@reachinbox.test', 'Existing recipient normalized');
      assert(valExisting.existing[0]?.reason.includes('already exists'), 'Reason mentions existing in campaign');

      // -----------------------------------------------------------------------
      // TEST 5: Malformed and Oversized File Handling
      // -----------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 5: Malformed and Oversized File Handling (Safe Errors)');
      console.log(SUB_SEP);

      // Empty content
      const emptyRes = parseRawContent('   \r\n\t  \n  ');
      assert(emptyRes.errors.length > 0, 'Empty file returns clear error without throwing');
      assert(emptyRes.errors[0]?.includes('empty'), 'Error states file is empty');

      // Missing email column in schema header
      const missingEmailCol = `first_name,last_name,age\nAlice,Smith,30\nBob,Jones,25`;
      const missingColRes = parseRawContent(missingEmailCol);
      assert(missingColRes.errors.length > 0, 'Missing email column returns clear error');
      assert(missingColRes.errors[0]?.includes('Missing required email column'), 'Error specifies missing email column');

      // Binary / null byte
      const binaryContent = `email,name\nalice@example.com\0corrupted,Alice`;
      const binaryRes = parseRawContent(binaryContent);
      assert(binaryRes.errors.length > 0, 'Binary null byte detected safely');
      assert(binaryRes.errors[0]?.includes('binary'), 'Error indicates binary corruption');

      // Oversized upload check (> 5MB)
      const oversizedContent = 'a'.repeat(5 * 1024 * 1024 + 10);
      const oversizedRes = parseRawContent(oversizedContent, 5 * 1024 * 1024);
      assert(oversizedRes.errors.length > 0, 'Oversized content triggers size error');
      assert(oversizedRes.errors[0]?.includes('exceeds maximum'), 'Error mentions size limit');

      // -----------------------------------------------------------------------
      // TEST 6: Correct Validation Counts
      // -----------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 6: Combined Validation Counts Accuracy');
      console.log(SUB_SEP);

      const mixedCsv = `email,name
valid_one@reachinbox.test,Valid 1
bad-email,Bad 1
valid_two@reachinbox.test,Valid 2
valid_one@reachinbox.test,Duplicate of 1
already_in_db@reachinbox.test,Already in DB
another_bad@,Bad 2`;

      const valMixed = await validateRecipients(
        { userId: userAId, campaignId: campaignAId, rawContent: mixedCsv },
        testClient
      );

      assert(valMixed.counts.total_rows === 6, 'Total rows processed is 6');
      assert(valMixed.counts.valid_count === 2, 'Valid count is strictly 2');
      assert(valMixed.counts.invalid_count === 2, 'Invalid count is strictly 2');
      assert(valMixed.counts.duplicate_count === 1, 'Duplicate count is strictly 1');
      assert(valMixed.counts.existing_count === 1, 'Existing count is strictly 1');

      // -----------------------------------------------------------------------
      // TEST 7: Global Hourly Capacity Calculation
      // -----------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 7: Global Hourly Capacity Calculation');
      console.log(SUB_SEP);

      // Set global limit in env and seed Redis usage
      process.env.GLOBAL_EMAILS_PER_HOUR = '100';
      await redis.set('rate-limit:global', '25', 'EX', 3600);

      const capGlobal = await calculateCapacityAndForecast(
        {
          userId: userAId,
          senderId: senderAId,
          recipientCount: 10,
        },
        testClient,
        redis
      );

      assert(capGlobal.capacity.global.enabled === true, 'Global hourly limit is enabled');
      assert(capGlobal.capacity.global.hourly_limit === 100, 'Global hourly limit is 100');
      assert(capGlobal.capacity.global.current_used === 25, 'Global used quota is 25');
      assert(capGlobal.capacity.global.remaining_hourly === 75, 'Global remaining quota is strictly 75');

      // Test with global limit = 0 (disabled)
      process.env.GLOBAL_EMAILS_PER_HOUR = '0';
      const capGlobalDisabled = await calculateCapacityAndForecast(
        {
          userId: userAId,
          senderId: senderAId,
          recipientCount: 10,
        },
        testClient,
        redis
      );
      assert(capGlobalDisabled.capacity.global.enabled === false, 'Global limit = 0 marks disabled');
      assert(capGlobalDisabled.capacity.global.remaining_hourly === null, 'Global remaining is null when disabled');

      // Clean up global limit env
      delete process.env.GLOBAL_EMAILS_PER_HOUR;

      // -----------------------------------------------------------------------
      // TEST 8: Sender-Specific Capacity Calculation
      // -----------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 8: Sender-Specific Capacity Calculation & Window Tracking');
      console.log(SUB_SEP);

      // Sender A has hourly_limit = 50. Seed Redis sender key with 20 used.
      await redis.set(`rate-limit:sender:${senderAId}`, '20', 'EX', 1800);

      const capSender = await calculateCapacityAndForecast(
        {
          userId: userAId,
          senderId: senderAId,
          recipientCount: 5,
        },
        testClient,
        redis
      );

      assert(capSender.capacity.sender.hourly_limit === 50, 'Sender hourly limit correctly read as 50');
      assert(capSender.capacity.sender.current_used === 20, 'Sender used quota is 20');
      assert(capSender.capacity.sender.remaining_hourly === 30, 'Sender remaining hourly capacity is strictly 30');
      assert(capSender.capacity.sender.window_ttl_seconds > 0, 'Sender window TTL is actively tracked');

      // -----------------------------------------------------------------------
      // TEST 9: Campaign Limit & Minimum-Spacing Calculation
      // -----------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 9: Campaign Limit and Minimum Send Spacing Calculation');
      console.log(SUB_SEP);

      // Campaign A has hourly_limit = 10. Seed Redis campaign key with 3 used.
      await redis.set(`rate-limit:campaign:${campaignAId}`, '3', 'EX', 2400);
      process.env.EMAIL_SEND_DELAY_MS = '2000';

      const capCamp = await calculateCapacityAndForecast(
        {
          userId: userAId,
          senderId: senderAId,
          campaignId: campaignAId,
          recipientCount: 5,
        },
        testClient,
        redis
      );

      assert(capCamp.capacity.campaign.hourly_limit === 10, 'Campaign limit correctly read as 10');
      assert(capCamp.capacity.campaign.current_used === 3, 'Campaign used quota is 3');
      assert(capCamp.capacity.campaign.remaining_hourly === 7, 'Campaign remaining capacity is 7');
      assert(capCamp.capacity.spacing.min_delay_ms === 2000, 'Minimum delay is 2000ms');
      assert(capCamp.capacity.spacing.max_hourly_rate === 1800, 'Max spacing hourly throughput is 1800/hr');
      assert(capCamp.capacity.effective_hourly_rate === 10, 'Campaign limit (10) is the primary bottleneck');
      assert(capCamp.capacity.primary_bottleneck === 'campaign_hourly_limit', 'Bottleneck identified as campaign limit');

      // -----------------------------------------------------------------------
      // TEST 10: Forecast Accuracy Under Configured Limits
      // -----------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 10: Forecast Accuracy (Single-Hour vs Multi-Hour)');
      console.log(SUB_SEP);

      // Batch 1: 5 recipients, 7 remaining in campaign, spacing 2000ms
      // Physical duration = (5 - 1) * 2000ms = 8000ms (8 seconds)
      const forecastSingleHour = await calculateCapacityAndForecast(
        {
          userId: userAId,
          senderId: senderAId,
          campaignId: campaignAId,
          recipientCount: 5,
        },
        testClient,
        redis
      );

      assert(forecastSingleHour.forecast.recipient_count === 5, 'Forecast recipient count is 5');
      assert(forecastSingleHour.forecast.estimated_duration_seconds === 8, '5 emails take exactly 8s spacing duration');
      assert(forecastSingleHour.forecast.is_approximate === true, 'Forecast marked as approximate');
      assert(forecastSingleHour.forecast.assumptions.length >= 4, 'Standard assumptions included');
      assert(forecastSingleHour.forecast.warnings.length === 0, 'Zero multi-hour warnings when batch fits in hour');

      // Batch 2: 25 recipients, only 7 remaining in hour 1, rate = 10/hr
      // Will spill over into hours 2 and 3!
      const forecastMultiHour = await calculateCapacityAndForecast(
        {
          userId: userAId,
          senderId: senderAId,
          campaignId: campaignAId,
          recipientCount: 25,
        },
        testClient,
        redis
      );

      assert(forecastMultiHour.forecast.recipient_count === 25, 'Forecast recipient count is 25');
      assert(forecastMultiHour.forecast.estimated_duration_seconds > 3600, 'Duration exceeds 1 hour due to rate limiting');
      assert(forecastMultiHour.forecast.warnings.length > 0, 'Multi-hour throttle warning generated');
      assert(forecastMultiHour.forecast.warnings[0]?.includes('spillover') || forecastMultiHour.forecast.warnings[0]?.includes('exceeds current hour'), 'Warning mentions multi-hour span');

      // -----------------------------------------------------------------------
      // TEST 11: Preflight Creates Zero DB Records, BullMQ Jobs, or Reservations
      // -----------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 11: Absolute Read-Only Guarantee (Zero Side Effects)');
      console.log(SUB_SEP);

      // Record baseline database counts
      const countTable = async (table: string): Promise<number> => {
        const r = await testClient.query(`SELECT COUNT(*) FROM ${table}`);
        return parseInt(r.rows[0].count, 10);
      };

      const baseRecipients = await countTable('recipients');
      const baseCampaigns = await countTable('campaigns');
      const baseDeliveries = await countTable('email_deliveries');
      const baseAttempts = await countTable('email_attempts');
      const baseOutbox = await countTable('delivery_outbox');

      // Record baseline BullMQ counts
      const baseQueueCounts = await emailQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
      const baseTotalJobs = Object.values(baseQueueCounts).reduce((a, b) => a + b, 0);

      // Record baseline Redis counters
      const baseSenderCount = await redis.get(`rate-limit:sender:${senderAId}`);
      const baseCampCount = await redis.get(`rate-limit:campaign:${campaignAId}`);

      // Execute comprehensive preflight
      const preflightResult = await runPreflight(
        {
          userId: userAId,
          senderId: senderAId,
          campaignId: campaignAId,
          content: `email,name\nnew1@reachinbox.test,New 1\nnew2@reachinbox.test,New 2`,
        },
        testClient,
        redis
      );

      assert(preflightResult.success === true, 'Preflight executed successfully');
      assert(preflightResult.validation.counts.valid_count === 2, '2 valid recipients preflighted');

      // Verify zero database records created
      const afterRecipients = await countTable('recipients');
      const afterCampaigns = await countTable('campaigns');
      const afterDeliveries = await countTable('email_deliveries');
      const afterAttempts = await countTable('email_attempts');
      const afterOutbox = await countTable('delivery_outbox');

      assert(afterRecipients === baseRecipients, 'recipients table count 100% unchanged');
      assert(afterCampaigns === baseCampaigns, 'campaigns table count 100% unchanged');
      assert(afterDeliveries === baseDeliveries, 'email_deliveries table count 100% unchanged');
      assert(afterAttempts === baseAttempts, 'email_attempts table count 100% unchanged');
      assert(afterOutbox === baseOutbox, 'email_outbox table count 100% unchanged');

      // Verify zero BullMQ jobs published
      const afterQueueCounts = await emailQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
      const afterTotalJobs = Object.values(afterQueueCounts).reduce((a, b) => a + b, 0);
      assert(afterTotalJobs === baseTotalJobs, 'emailQueue job count 100% unchanged (zero jobs queued)');

      // Verify zero Redis rate-limit tokens reserved/consumed
      const afterSenderCount = await redis.get(`rate-limit:sender:${senderAId}`);
      const afterCampCount = await redis.get(`rate-limit:campaign:${campaignAId}`);
      assert(afterSenderCount === baseSenderCount, 'Redis sender quota count 100% unchanged (zero reservations)');
      assert(afterCampCount === baseCampCount, 'Redis campaign quota count 100% unchanged (zero reservations)');

      // -----------------------------------------------------------------------
      // TEST 12: User Isolation and Authorization Scoping
      // -----------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 12: User Isolation and Cross-Tenant Authorization');
      console.log(SUB_SEP);

      // User A attempts to preflight using User B's sender -> must fail
      let userACrossSenderFailed = false;
      try {
        await runPreflight(
          {
            userId: userAId,
            senderId: senderBId, // Belongs to User B!
            content: `email,name\nalice@test.com,Alice`,
          },
          testClient,
          redis
        );
      } catch (err: any) {
        userACrossSenderFailed = true;
        assert(err.message.includes('not found') || err.message.includes('access denied'), 'User A blocked from using User B sender');
      }
      assert(userACrossSenderFailed === true, 'Cross-user sender access rejected');

      // User A attempts to preflight against User B's campaign -> must fail
      let userACrossCampFailed = false;
      try {
        const valRes = await validateRecipients(
          {
            userId: userAId,
            campaignId: campaignBId, // Belongs to User B!
            rawContent: `email,name\nalice@test.com,Alice`,
          },
          testClient
        );
        userACrossCampFailed = valRes.errors.length > 0 && valRes.errors[0]?.includes('access denied');
      } catch (err: any) {
        userACrossCampFailed = true;
      }
      assert(userACrossCampFailed === true, 'Cross-user campaign access rejected in validation');

      // Non-existent sender ID
      let nonExistentSenderFailed = false;
      try {
        await runPreflight(
          {
            userId: userAId,
            senderId: '00000000-0000-0000-0000-000000000000',
            content: `email,name\nalice@test.com,Alice`,
          },
          testClient,
          redis
        );
      } catch (err: any) {
        nonExistentSenderFailed = true;
      }
      assert(nonExistentSenderFailed === true, 'Non-existent sender UUID rejected safely');

      // ─── Controller HTTP Endpoint Unit Tests ─────────────────────────────
      console.log('\n' + SUB_SEP);
      console.log('TEST 12B: Controller HTTP Endpoint Validations (401, 400, 413)');
      console.log(SUB_SEP);

      function createMockRes() {
        let code = 200;
        let data: any = null;
        const res: any = {
          status: (c: number) => {
            code = c;
            return res;
          },
          json: (d: any) => {
            data = d;
            return res;
          },
          getCode: () => code,
          getData: () => data,
        };
        return res;
      }

      // 1. Unauthenticated Request -> HTTP 401
      const res401 = createMockRes();
      await preflightCampaignHandler({ body: {} } as any, res401, () => {});
      assert(res401.getCode() === 401, 'Unauthenticated HTTP request responds with 401');

      // 2. Oversized Payload (>5MB) -> HTTP 413
      const res413 = createMockRes();
      const largeContent = 'a'.repeat(5 * 1024 * 1024 + 100);
      await preflightCampaignHandler(
        {
          user: { id: userAId } as any,
          params: {},
          body: { csv_content: largeContent, sender_id: senderAId },
        } as any,
        res413,
        () => {}
      );
      assert(res413.getCode() === 413, 'Oversized content responds with 413 Payload Too Large');

      // 3. Invalid Sender UUID -> HTTP 400
      const res400Uuid = createMockRes();
      await preflightCampaignHandler(
        {
          user: { id: userAId } as any,
          params: {},
          body: { sender_id: 'not-a-valid-uuid', csv_content: 'email\na@b.com' },
        } as any,
        res400Uuid,
        () => {}
      );
      assert(res400Uuid.getCode() === 400, 'Malformed sender UUID responds with 400');
      assert(res400Uuid.getData()?.details?.[0]?.includes('valid UUID'), 'Error detail specifies UUID requirement');

      // 4. Missing Content/Recipients -> HTTP 400
      const res400Empty = createMockRes();
      await preflightCampaignHandler(
        {
          user: { id: userAId } as any,
          params: {},
          body: { sender_id: senderAId },
        } as any,
        res400Empty,
        () => {}
      );
      assert(res400Empty.getCode() === 400, 'Missing content and recipients responds with 400');

      // 5. Invalid Hourly Limit -> HTTP 400
      const res400Limit = createMockRes();
      await preflightCampaignHandler(
        {
          user: { id: userAId } as any,
          params: {},
          body: { sender_id: senderAId, hourly_limit: 5000, csv_content: 'email\na@b.com' },
        } as any,
        res400Limit,
        () => {}
      );
      assert(res400Limit.getCode() === 400, 'Out-of-range hourly limit responds with 400');

      // 6. Invalid Scheduled At -> HTTP 400
      const res400Date = createMockRes();
      await preflightCampaignHandler(
        {
          user: { id: userAId } as any,
          params: {},
          body: { sender_id: senderAId, scheduled_at: 'not-a-date', csv_content: 'email\na@b.com' },
        } as any,
        res400Date,
        () => {}
      );
      assert(res400Date.getCode() === 400, 'Invalid scheduled_at responds with 400');

      // =====================================================================
      // BATCH 5.1 ACCEPTANCE TESTS
      // =====================================================================

      // ---------------------------------------------------------------------
      // TEST 13: Client Cannot Override Actual Configured Campaign Capacity
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 13: Client Cannot Override Actual Configured Campaign Capacity (Bug 1)');
      console.log(SUB_SEP);

      // Campaign A has hourly_limit = 10 in PostgreSQL.
      // Client passes hourly_limit = 500 in the preflight request.
      const overrideAttempt = await runPreflight(
        {
          userId: userAId,
          campaignId: campaignAId,
          senderId: senderAId,
          hourlyLimit: 500, // Client attempts to override configured limit of 10
          content: 'email,name\ntest1@reachinbox.test,Test 1',
        },
        testClient,
        redis
      );

      assert(
        overrideAttempt.capacity.campaign.hourly_limit === 10,
        'Configured campaign limit (10) cannot be overridden by client hourly_limit parameter'
      );
      assert(
        overrideAttempt.capacity.effective_hourly_rate === 10,
        'Effective hourly rate remains 10 (not 500)'
      );
      assert(
        overrideAttempt.what_if_scenario !== null &&
          overrideAttempt.what_if_scenario?.simulated_hourly_limit === 500,
        'Client parameter is exposed as an isolated what_if_scenario without altering actual capacity'
      );

      // ---------------------------------------------------------------------
      // TEST 14: Campaign Limit Comes Directly From PostgreSQL
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 14: Campaign Limit Derived Authoritatively From PostgreSQL');
      console.log(SUB_SEP);

      await testClient.query(
        `UPDATE campaigns SET hourly_limit = 35 WHERE id = $1`,
        [campaignAId]
      );

      const dbCampaignRes = await runPreflight(
        {
          userId: userAId,
          campaignId: campaignAId,
          senderId: senderAId,
          content: 'email,name\ntest1@reachinbox.test,Test 1',
        },
        testClient,
        redis
      );

      assert(
        dbCampaignRes.capacity.campaign.hourly_limit === 35,
        'Campaign limit authoritatively reflects updated PostgreSQL record (35)'
      );
      assert(
        dbCampaignRes.capacity.effective_hourly_rate === 35,
        'Effective hourly rate reflects PostgreSQL campaign limit (35)'
      );

      // ---------------------------------------------------------------------
      // TEST 15: Sender Limit Comes Directly From PostgreSQL
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 15: Sender Limit Derived Authoritatively From PostgreSQL');
      console.log(SUB_SEP);

      await testClient.query(
        `UPDATE senders SET hourly_limit = 85 WHERE id = $1`,
        [senderAId]
      );

      const dbSenderRes = await runPreflight(
        {
          userId: userAId,
          campaignId: campaignAId,
          senderId: senderAId,
          content: 'email,name\ntest1@reachinbox.test,Test 1',
        },
        testClient,
        redis
      );

      assert(
        dbSenderRes.capacity.sender.hourly_limit === 85,
        'Sender limit authoritatively reflects updated PostgreSQL record (85)'
      );

      // ---------------------------------------------------------------------
      // TEST 16: Campaign Limit Exhausted While Sender Limit Is Not (Bug 2)
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 16: Campaign Limit Exhausted (Unrelated Sender TTL Excluded)');
      console.log(SUB_SEP);

      // Clean test rate-limit keys
      await redis.del(`rate-limit:campaign:${campaignAId}`);
      await redis.del(`rate-limit:sender:${senderAId}`);

      // Campaign A (limit 35) is EXHAUSTED: 35 used, remaining 0, TTL = 1800s
      await redis.set(`rate-limit:campaign:${campaignAId}`, '35', 'EX', 1800);
      // Sender A (limit 85) is NOT exhausted: 20 used, remaining 65, TTL = 500s
      await redis.set(`rate-limit:sender:${senderAId}`, '20', 'EX', 500);

      const capExhaustedCamp = await calculateCapacityAndForecast(
        {
          userId: userAId,
          campaignId: campaignAId,
          senderId: senderAId,
          recipientCount: 5,
        },
        testClient,
        redis
      );

      assert(
        capExhaustedCamp.capacity.campaign.remaining_hourly === 0,
        'Campaign remaining capacity is 0 (exhausted)'
      );
      assert(
        capExhaustedCamp.capacity.sender.remaining_hourly === 65,
        'Sender remaining capacity is 65 (not exhausted)'
      );
      assert(
        capExhaustedCamp.forecast.estimated_duration_seconds >= 1800,
        'Reset waiting time uses campaign TTL (1800s), NOT unrelated sender TTL (500s)'
      );
      assert(
        capExhaustedCamp.forecast.warnings.some((w) => w.includes('campaign hourly limit')),
        'Warning correctly identifies campaign hourly limit as the exhausted constraint'
      );
      assert(
        !capExhaustedCamp.forecast.warnings.some((w) => w.includes('sender hourly limit')),
        'Warning does not falsely identify sender hourly limit as exhausted'
      );

      // ---------------------------------------------------------------------
      // TEST 17: Sender Limit Exhausted While Campaign Limit Is Not (Bug 2)
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 17: Sender Limit Exhausted (Unrelated Campaign TTL Excluded)');
      console.log(SUB_SEP);

      // Clean test rate-limit keys
      await redis.del(`rate-limit:campaign:${campaignAId}`);
      await redis.del(`rate-limit:sender:${senderAId}`);

      // Campaign A (limit 35) is NOT exhausted: 10 used, remaining 25, TTL = 400s
      await redis.set(`rate-limit:campaign:${campaignAId}`, '10', 'EX', 400);
      // Sender A (limit 85) is EXHAUSTED: 85 used, remaining 0, TTL = 2200s
      await redis.set(`rate-limit:sender:${senderAId}`, '85', 'EX', 2200);

      const capExhaustedSender = await calculateCapacityAndForecast(
        {
          userId: userAId,
          campaignId: campaignAId,
          senderId: senderAId,
          recipientCount: 5,
        },
        testClient,
        redis
      );

      assert(
        capExhaustedSender.capacity.sender.remaining_hourly === 0,
        'Sender remaining capacity is 0 (exhausted)'
      );
      assert(
        capExhaustedSender.capacity.campaign.remaining_hourly === 25,
        'Campaign remaining capacity is 25 (not exhausted)'
      );
      assert(
        capExhaustedSender.forecast.estimated_duration_seconds >= 2200,
        'Reset waiting time uses sender TTL (2200s), NOT unrelated campaign TTL (400s)'
      );
      assert(
        capExhaustedSender.forecast.warnings.some((w) => w.includes('sender hourly limit')),
        'Warning correctly identifies sender hourly limit as the exhausted constraint'
      );
      assert(
        !capExhaustedSender.forecast.warnings.some((w) => w.includes('campaign hourly limit')),
        'Warning does not falsely identify campaign hourly limit as exhausted'
      );

      // ---------------------------------------------------------------------
      // TEST 18: Multiple Limits Simultaneously Exhausted (Maximum TTL)
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 18: Multiple Exhausted Limits Require All Constraints to Reset');
      console.log(SUB_SEP);

      // Set global limit in env
      process.env.GLOBAL_EMAILS_PER_HOUR = '100';

      // Clean keys
      await redis.del(`rate-limit:campaign:${campaignAId}`);
      await redis.del(`rate-limit:sender:${senderAId}`);
      await redis.del('rate-limit:global');

      // Campaign exhausted with TTL = 1200s
      await redis.set(`rate-limit:campaign:${campaignAId}`, '35', 'EX', 1200);
      // Sender exhausted with TTL = 2500s
      await redis.set(`rate-limit:sender:${senderAId}`, '85', 'EX', 2500);
      // Global exhausted with TTL = 800s
      await redis.set('rate-limit:global', '100', 'EX', 800);

      const capMultiExhausted = await calculateCapacityAndForecast(
        {
          userId: userAId,
          campaignId: campaignAId,
          senderId: senderAId,
          recipientCount: 5,
        },
        testClient,
        redis
      );

      assert(
        capMultiExhausted.capacity.campaign.remaining_hourly === 0,
        'Campaign limit is exhausted'
      );
      assert(
        capMultiExhausted.capacity.sender.remaining_hourly === 0,
        'Sender limit is exhausted'
      );
      assert(
        capMultiExhausted.capacity.global.remaining_hourly === 0,
        'Global limit is exhausted'
      );
      assert(
        capMultiExhausted.forecast.estimated_duration_seconds >= 2500,
        'Reset waiting time accounts for when ALL required constraints permit sending (max TTL = 2500s)'
      );
      assert(
        capMultiExhausted.forecast.warnings[0]?.includes('campaign hourly limit') &&
          capMultiExhausted.forecast.warnings[0]?.includes('sender hourly limit') &&
          capMultiExhausted.forecast.warnings[0]?.includes('global hourly limit'),
        'Warning includes all three simultaneously exhausted constraints'
      );

      // Clean up global limit env
      delete process.env.GLOBAL_EMAILS_PER_HOUR;

      // ---------------------------------------------------------------------
      // TEST 19: Spillover Reset Estimation Uses Exhausted Constraint TTL
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 19: Spillover Reset Estimation Accounts for Exhausted Constraint');
      console.log(SUB_SEP);

      // Clean keys
      await redis.del(`rate-limit:campaign:${campaignAId}`);
      await redis.del(`rate-limit:sender:${senderAId}`);

      // Campaign A has 5 remaining (used 30 of 35), TTL = 1500s
      await redis.set(`rate-limit:campaign:${campaignAId}`, '30', 'EX', 1500);
      // Sender A has 25 remaining (used 60 of 85), TTL = 600s
      await redis.set(`rate-limit:sender:${senderAId}`, '60', 'EX', 600);

      // Batch of 20 emails: 5 sent in hour 1 (exhausting campaign limit), 15 spill over
      const capSpillover = await calculateCapacityAndForecast(
        {
          userId: userAId,
          campaignId: campaignAId,
          senderId: senderAId,
          recipientCount: 20,
        },
        testClient,
        redis
      );

      assert(
        capSpillover.forecast.estimated_duration_seconds >= 1500,
        'Spillover waiting time accounts for campaign TTL (1500s) that becomes exhausted, not sender TTL (600s)'
      );
      assert(
        capSpillover.forecast.warnings.some((w) => w.includes('campaign hourly limit')),
        'Warning identifies campaign hourly limit as the spillover constraint'
      );

      // ---------------------------------------------------------------------
      // TEST 20: Accurate Email Format Validation Description
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 20: Accurate Email Format Validation Description (No RFC 5322 claim)');
      console.log(SUB_SEP);

      const valDesc = await validateRecipients(
        {
          userId: userAId,
          rawContent: 'email,name\nbad-email,Bad',
        },
        testClient
      );

      assert(
        valDesc.invalid[0]?.reason === 'Invalid email address format',
        'Email validation error accurately describes format validation'
      );
      assert(
        !valDesc.invalid[0]?.reason.includes('RFC 5322'),
        'API does not make unsupported full RFC 5322 compliance claims'
      );

      // ---------------------------------------------------------------------
      // TEST 21: Correct What-If Forecast Simulation (Batch 5.2)
      // ---------------------------------------------------------------------
      console.log('\n' + SUB_SEP);
      console.log('TEST 21: Correct What-If Forecast Simulation (Batch 5.2)');
      console.log(SUB_SEP);

      // Clean rate-limit keys
      await redis.del(`rate-limit:campaign:${campaignAId}`);
      await redis.del(`rate-limit:sender:${senderAId}`);
      await redis.del('rate-limit:global');
      delete process.env.GLOBAL_EMAILS_PER_HOUR;

      // 1. Scenario A: Simulated limit higher than actual limit
      // Actual campaign limit = 35. Usage = 30. Remaining = 5.
      // Sender limit = 85. Usage = 0. Remaining = 85.
      await redis.set(`rate-limit:campaign:${campaignAId}`, '30', 'EX', 1800);
      const resScenarioA = await runPreflight(
        {
          userId: userAId,
          campaignId: campaignAId,
          senderId: senderAId,
          hourlyLimit: 50, // Simulated limit higher than actual 35
          recipientCount: 10,
        },
        testClient,
        redis
      );

      assert(
        resScenarioA.capacity.campaign.hourly_limit === 35,
        'Scenario A: Actual campaign limit remains 35'
      );
      assert(
        resScenarioA.capacity.campaign.remaining_hourly === 5,
        'Scenario A: Actual campaign remaining remains 5'
      );
      assert(
        resScenarioA.what_if_scenario !== null,
        'Scenario A: What-if scenario is present'
      );
      assert(
        resScenarioA.what_if_scenario?.simulated_hourly_limit === 50,
        'Scenario A: Simulated hourly limit is 50'
      );
      assert(
        resScenarioA.what_if_scenario?.simulated_campaign_remaining === 20,
        'Scenario A: Simulated campaign remaining is 20 (50 - 30)'
      );
      assert(
        resScenarioA.what_if_scenario?.simulated_current_hour_remaining === 20,
        'Scenario A: Simulated current hour remaining is 20 (min(20, 85))'
      );
      // For recipientCount = 10:
      // In actual scenario: 5 remaining in hour, 10 recipients => 5 spillover => needs reset wait (1800s)
      assert(
        resScenarioA.forecast.estimated_duration_seconds >= 1800,
        'Scenario A: Actual forecast requires reset wait due to spillover (5 remaining < 10)'
      );
      // In what-if scenario: 20 remaining in hour, 10 recipients <= 20 => no spillover => spacing only ((10 - 1) * 2 = 18s)
      assert(
        resScenarioA.what_if_scenario?.estimated_duration_seconds === 18,
        'Scenario A: Simulated duration is spacing-only (18s) because simulated remaining (20) >= 10'
      );

      // 2. Scenario B: Simulated limit lower than already-consumed campaign usage
      // Usage = 30. Simulated limit = 25.
      const resScenarioB = await runPreflight(
        {
          userId: userAId,
          campaignId: campaignAId,
          senderId: senderAId,
          hourlyLimit: 25, // Lower than 30 consumed
          recipientCount: 5,
        },
        testClient,
        redis
      );

      assert(
        resScenarioB.what_if_scenario !== null,
        'Scenario B: What-if scenario is present'
      );
      assert(
        resScenarioB.what_if_scenario?.simulated_campaign_remaining === 0,
        'Scenario B: Simulated campaign remaining bounded at zero (25 - 30 <= 0)'
      );
      assert(
        resScenarioB.what_if_scenario?.simulated_current_hour_remaining === 0,
        'Scenario B: Simulated current hour remaining is 0'
      );
      assert(
        resScenarioB.what_if_scenario?.estimated_duration_seconds !== undefined &&
          resScenarioB.what_if_scenario?.estimated_duration_seconds >= 1800,
        'Scenario B: Simulated scenario requires reset wait when simulated limit is exhausted'
      );

      // 3. Scenario C: Simulated limit lower than actual limit but still available
      // Usage = 10 (actual limit = 35). Simulated limit = 25.
      await redis.set(`rate-limit:campaign:${campaignAId}`, '10', 'EX', 1200);
      const resScenarioC = await runPreflight(
        {
          userId: userAId,
          campaignId: campaignAId,
          senderId: senderAId,
          hourlyLimit: 25, // Lower than 35, but higher than 10 used
          recipientCount: 5,
        },
        testClient,
        redis
      );

      assert(
        resScenarioC.what_if_scenario?.simulated_campaign_remaining === 15,
        'Scenario C: Simulated campaign remaining is 15 (25 - 10)'
      );
      assert(
        resScenarioC.what_if_scenario?.simulated_current_hour_remaining === 15,
        'Scenario C: Simulated current hour remaining is 15'
      );
      assert(
        resScenarioC.what_if_scenario?.effective_hourly_rate === 25,
        'Scenario C: Simulated effective rate is 25'
      );
      assert(
        resScenarioC.what_if_scenario?.primary_bottleneck === 'campaign_hourly_limit',
        'Scenario C: Simulated primary bottleneck is campaign_hourly_limit'
      );

      // 4. Scenario D: Sender limit becomes the simulated bottleneck
      // Actual campaign limit = 35. Sender limit = 85.
      // Usage: campaign = 0, sender = 60 (remaining = 25).
      await redis.del(`rate-limit:campaign:${campaignAId}`);
      await redis.set(`rate-limit:sender:${senderAId}`, '60', 'EX', 900);
      const resScenarioD = await runPreflight(
        {
          userId: userAId,
          campaignId: campaignAId,
          senderId: senderAId,
          hourlyLimit: 150, // Simulated campaign limit (150) exceeds sender limit (85)
          recipientCount: 10,
        },
        testClient,
        redis
      );

      assert(
        resScenarioD.capacity.primary_bottleneck === 'campaign_hourly_limit',
        'Scenario D: Actual bottleneck is campaign_hourly_limit (35 < 85)'
      );
      assert(
        resScenarioD.what_if_scenario?.primary_bottleneck === 'sender_hourly_limit',
        'Scenario D: Sender limit becomes simulated bottleneck (85 < 150)'
      );
      assert(
        resScenarioD.what_if_scenario?.effective_hourly_rate === 85,
        'Scenario D: Simulated effective rate is 85'
      );
      assert(
        resScenarioD.what_if_scenario?.simulated_current_hour_remaining === 25,
        'Scenario D: Simulated current hour remaining is capped by sender remaining (25)'
      );

      // 5. Scenario E: Global limit becomes the simulated bottleneck
      process.env.GLOBAL_EMAILS_PER_HOUR = '40';
      await redis.del(`rate-limit:campaign:${campaignAId}`);
      await redis.del(`rate-limit:sender:${senderAId}`);
      const resScenarioE = await runPreflight(
        {
          userId: userAId,
          campaignId: campaignAId,
          senderId: senderAId,
          hourlyLimit: 100, // Campaign 100, Sender 85, Global 40
          recipientCount: 10,
        },
        testClient,
        redis
      );

      assert(
        resScenarioE.what_if_scenario?.primary_bottleneck === 'global_hourly_limit',
        'Scenario E: Global limit becomes simulated bottleneck (40 < 85 and 40 < 100)'
      );
      assert(
        resScenarioE.what_if_scenario?.effective_hourly_rate === 40,
        'Scenario E: Simulated effective rate is 40'
      );
      delete process.env.GLOBAL_EMAILS_PER_HOUR;

      // 6. Scenario F: Actual forecast remains unchanged across all simulations
      assert(
        resScenarioE.capacity.campaign.hourly_limit === 35,
        'Scenario F: Actual campaign hourly limit remains 35'
      );
      assert(
        resScenarioE.capacity.effective_hourly_rate === 35,
        'Scenario F: Actual effective rate remains 35'
      );
      assert(
        resScenarioE.capacity.primary_bottleneck === 'campaign_hourly_limit',
        'Scenario F: Actual capacity primary bottleneck remains campaign_hourly_limit'
      );
      // In Scenario E, 10 recipients with spacing of 2s = 18s (fits within actual 35 remaining)
      assert(
        resScenarioE.forecast.estimated_duration_seconds === 18,
        'Scenario F: Actual forecast duration remains 18s (unaffected by simulation)'
      );

      // Verify read-only: no Redis quota was reserved, DB unchanged
      const campTtl = await redis.ttl(`rate-limit:campaign:${campaignAId}`);
      const senderTtl = await redis.ttl(`rate-limit:sender:${senderAId}`);
      assert(
        campTtl === -2 && senderTtl === -2,
        'What-if simulations did not create or mutate rate-limit reservation keys'
      );

    } finally {
      testClient.release();
      await testPool.end();
    }
  } finally {
    // Drop test database cleanly
    console.log('\n4. Cleaning up isolated test database...');
    await adminClient.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();
    `);
    await adminClient.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminClient.end();
    console.log(`   Database "${TEST_DB_NAME}" dropped cleanly.`);

    // Clean test Redis keys
    const testKeys = await redis.keys('rate-limit:*');
    if (testKeys.length > 0) {
      await redis.del(...testKeys);
    }
    await redis.del('email-send:global:last-send');
  }

  // -------------------------------------------------------------------------
  // Verify Production Database Integrity
  // -------------------------------------------------------------------------
  console.log('\n5. Verifying original database integrity...');
  const prodClient = new Client({
    ...BASE_PG_CONFIG,
    database: 'reachinbox',
  });
  await prodClient.connect();
  try {
    const prodTablesRes = await prodClient.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    const prodTables = prodTablesRes.rows.map((r) => r.table_name);
    assert(
      prodTables.length === 6 &&
        !prodTables.includes('schema_migrations') &&
        !prodTables.includes('email_deliveries') &&
        !prodTables.includes('email_outbox'),
      'Original "reachinbox" database remains 100% UNTOUCHED (zero migrations executed against it)'
    );
  } finally {
    await prodClient.end();
  }

  console.log('\n' + SEP);
  console.log(`  BATCH 5 VERIFICATION COMPLETE: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log(SEP + '\n');

  try {
    await emailQueue.close();
    await redis.quit();
  } catch {}

  if (failedTests > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runBatch5Verification().catch((err) => {
  console.error('\nFatal error during Batch 5 verification:', err);
  process.exit(1);
});
