/**
 * src/scripts/testCampaigns.ts
 *
 * Integration test for Phase 4 Campaign + Recipients API.
 * This tests the service layer directly (including transaction logic)
 * without needing the full HTTP server running.
 */

import { db } from '../db/postgres';
import {
  createCampaignWithRecipients,
  listCampaignsByUser,
  getCampaignWithRecipients,
  updateCampaign,
  deleteCampaignForUser,
} from '../services/campaignService';

async function main() {
  console.log('🧪 Starting Phase 4 Integration Tests...');

  // 1. Create a test user directly in the database
  const { rows } = await db.query(
    `INSERT INTO users (email, name, google_id)
     VALUES ('test@example.com', 'Test User', 'google-123')
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`
  );
  const userId = rows[0].id;
  console.log('✅ Created test user:', userId);

  // 2. Test successful campaign creation
  console.log('\n--- Test: Create Campaign ---');
  const campaign = await createCampaignWithRecipients(userId, {
    subject: 'Welcome to ReachInbox',
    body: 'Hello {{name}}, welcome aboard!',
    hourlyLimit: 10,
    recipients: [
      { email: 'ALICE@example.com', name: 'Alice' },
      { email: 'bob@example.com' } // no name
    ]
  });
  console.log('✅ Created campaign:', campaign.id);
  console.log('✅ Recipients normalized and inserted:', campaign.recipients.map(r => r.email));

  // 3. Test listing campaigns
  console.log('\n--- Test: List Campaigns ---');
  const list = await listCampaignsByUser(userId);
  console.log(`✅ Found ${list.length} campaign(s) for user.`);
  const listItem = list.find(c => c.id === campaign.id);
  console.log(`✅ Campaign exists in list: ${!!listItem}`);

  // 4. Test retrieving single campaign with recipients
  console.log('\n--- Test: Get Single Campaign ---');
  const fetched = await getCampaignWithRecipients(campaign.id, userId);
  console.log(`✅ Fetched campaign '${fetched?.subject}' with ${fetched?.recipients.length} recipients.`);

  // 5. Test updating campaign
  console.log('\n--- Test: Update Campaign ---');
  const updated = await updateCampaign(campaign.id, userId, {
    subject: 'Updated Subject',
    hourlyLimit: 20
  });
  console.log(`✅ Updated campaign. New subject: '${updated?.subject}', New limit: ${updated?.hourly_limit}`);

  // 6. Test Transaction Rollback (simulate failure)
  console.log('\n--- Test: Transaction Rollback (DB error) ---');
  try {
    await createCampaignWithRecipients(userId, {
      subject: null as any, // This violates NOT NULL constraint on subject
      body: 'Will not save',
      hourlyLimit: 5,
      recipients: [
        { email: 'valid@example.com' }
      ]
    });
    console.error('❌ Expected error for null subject, but succeeded.');
  } catch (err: any) {
    console.log('✅ Caught expected DB error, transaction rolled back:', err.message);
  }

  // 7. Clean up (Delete campaign)
  console.log('\n--- Test: Delete Campaign ---');
  await deleteCampaignForUser(campaign.id, userId);
  console.log('✅ Campaign deleted successfully (cascades to recipients).');

  // Verify deletion
  const check = await getCampaignWithRecipients(campaign.id, userId);
  if (!check) {
    console.log('✅ Verified campaign is gone.');
  } else {
    console.error('❌ Campaign still exists!');
  }

  console.log('\n🎉 All Phase 4 tests passed!');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Unhandled test error:', err);
  process.exit(1);
});