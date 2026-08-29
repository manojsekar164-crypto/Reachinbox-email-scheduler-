/**
 * src/scripts/testDb.ts
 *
 * Development-only integration test for PostgreSQL.
 * Proves the full CRUD chain works end-to-end.
 *
 * Run with:  npm run db:test
 *
 * This script is NOT exposed as an HTTP endpoint.
 * It connects to the DB, runs all four tables through insert/read/delete,
 * prints the results, and cleans up after itself.
 */

import { connectDB, disconnectDB } from '../db/postgres';
import {
  createUser,
  getUserById,
  createCampaign,
  getCampaignById,
  createRecipient,
  getRecipientById,
  createEmailLog,
  getEmailLogsByCampaign,
  deleteUser,
  checkDbHealth,
} from '../services/database.service';

const SEP = '-'.repeat(60);

async function runTest(): Promise<void> {
  console.log('\n' + SEP);
  console.log('  ReachInbox - PostgreSQL Integration Test');
  console.log(SEP + '\n');

  // 0. Health check
  console.log('0)  DB Health check...');
  await checkDbHealth();
  console.log('    OK  PostgreSQL is reachable.\n');

  // 1. Insert a test user
  console.log('1)  Inserting test user...');
  const user = await createUser(
    `test-${Date.now()}@reachinbox.dev`,
    'Test User',
  );
  console.log('    OK  User created:');
  console.log(`        id        : ${user.id}`);
  console.log(`        email     : ${user.email}`);
  console.log(`        name      : ${user.name}`);
  console.log(`        created_at: ${user.created_at.toISOString()}\n`);

  // 2. Insert a test campaign
  console.log('2)  Inserting test campaign...');
  const campaign = await createCampaign(
    user.id,
    'Hello from ReachInbox!',
    '<p>This is the email body.</p>',
    new Date(Date.now() + 3_600_000),
    10,
  );
  console.log('    OK  Campaign created:');
  console.log(`        id           : ${campaign.id}`);
  console.log(`        user_id      : ${campaign.user_id}`);
  console.log(`        subject      : ${campaign.subject}`);
  console.log(`        status       : ${campaign.status}`);
  console.log(`        hourly_limit : ${campaign.hourly_limit}`);
  console.log(`        scheduled_at : ${campaign.scheduled_at?.toISOString()}\n`);

  // 3. Insert a test recipient
  console.log('3)  Inserting test recipient...');
  const recipient = await createRecipient(
    campaign.id,
    'recipient@example.com',
    'Jane Doe',
  );
  console.log('    OK  Recipient created:');
  console.log(`        id          : ${recipient.id}`);
  console.log(`        campaign_id : ${recipient.campaign_id}`);
  console.log(`        email       : ${recipient.email}`);
  console.log(`        name        : ${recipient.name}`);
  console.log(`        status      : ${recipient.status}\n`);

  // 4. Insert an email log
  console.log('4)  Inserting email log...');
  const log = await createEmailLog(
    campaign.id,
    recipient.id,
    'sent',
    new Date(),
  );
  console.log('    OK  Email log created:');
  console.log(`        id           : ${log.id}`);
  console.log(`        campaign_id  : ${log.campaign_id}`);
  console.log(`        recipient_id : ${log.recipient_id}`);
  console.log(`        status       : ${log.status}`);
  console.log(`        sent_at      : ${log.sent_at?.toISOString()}\n`);

  // 5. Read all records back
  console.log('5)  Reading records back...');
  const fetchedUser      = await getUserById(user.id);
  const fetchedCampaign  = await getCampaignById(campaign.id);
  const fetchedRecipient = await getRecipientById(recipient.id);
  const fetchedLogs      = await getEmailLogsByCampaign(campaign.id);

  console.log('    OK  Read-back results:');
  console.log(`        users:       ${fetchedUser?.email}`);
  console.log(`        campaigns:   ${fetchedCampaign?.subject}`);
  console.log(`        recipients:  ${fetchedRecipient?.email}`);
  console.log(`        email_logs:  ${fetchedLogs.length} log(s) found\n`);

  // 6. Cleanup - deleting the user cascades to all child tables
  console.log('6)  Cleaning up test records (cascade delete via user)...');
  await deleteUser(user.id);
  console.log('    OK  All test records deleted.\n');

  console.log(SEP);
  console.log('  PASSED - All four tables work correctly.');
  console.log(SEP + '\n');
}

(async () => {
  try {
    await connectDB();
    await runTest();
  } catch (err) {
    console.error('\nFAILED:', err);
    process.exit(1);
  } finally {
    await disconnectDB();
  }
})();
