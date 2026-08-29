import { db as pool } from '../db/postgres';
import { esClient } from '../search/elasticsearch';
import {
  ensureIndex,
  indexScheduledEmails,
  indexEmailAsSent,
  searchEmails,
  checkElasticsearchHealth
} from '../services/searchService';
import { CampaignRow, RecipientRow } from '../types/db.types';
import { exec } from 'child_process';
import dotenv from 'dotenv';
import path from 'path';

// Ensure .env is loaded
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const INDEX_NAME = process.env.ELASTICSEARCH_INDEX || 'reachinbox-emails';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runCommandAsync(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function cleanupTestData(user1Id: string, user2Id: string) {
  try {
    // Delete from Postgres (cascades to campaigns, recipients, email_logs)
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [user1Id, user2Id]);

    // Delete from Elasticsearch using the correct query property directly at root
    await esClient.deleteByQuery({
      index: INDEX_NAME,
      refresh: true,
      query: {
        terms: { userId: [user1Id, user2Id] }
      }
    });
  } catch (err: any) {
    console.warn(`⚠️ Cleanup warning: ${err.message}`);
  }
}

async function main() {
  console.log('🧪 Starting ReachInbox Elasticsearch Verification Suite...\n');

  // Generate unique test user emails
  const u1Email = `search-tester-1-${Date.now()}@example.com`;
  const u2Email = `search-tester-2-${Date.now()}@example.com`;

  let user1Id = '';
  let user2Id = '';

  try {
    // -------------------------------------------------------------------------
    // 1. Elasticsearch Connectivity
    // -------------------------------------------------------------------------
    console.log('1. Verifying Elasticsearch connectivity...');
    const healthy = await checkElasticsearchHealth();
    if (healthy) {
      console.log('  ✅ PASS: Elasticsearch cluster is reachable.');
    } else {
      console.error('  ❌ FAIL: Elasticsearch cluster is unreachable. Make sure the container is running.');
      process.exit(1);
    }

    // -------------------------------------------------------------------------
    // 2. Index Creation
    // -------------------------------------------------------------------------
    console.log('2. Verifying Index mapping and creation...');
    await ensureIndex();
    const indexExists = await esClient.indices.exists({ index: INDEX_NAME });
    if (indexExists) {
      console.log(`  ✅ PASS: Index "${INDEX_NAME}" exists.`);
    } else {
      console.error(`  ❌ FAIL: Index "${INDEX_NAME}" was not created.`);
      process.exit(1);
    }

    // Setup Mock Users in Database
    const u1Res = await pool.query(
      "INSERT INTO users (email, name) VALUES ($1, 'Tester User One') RETURNING id",
      [u1Email]
    );
    user1Id = u1Res.rows[0].id;

    const u2Res = await pool.query(
      "INSERT INTO users (email, name) VALUES ($1, 'Tester User Two') RETURNING id",
      [u2Email]
    );
    user2Id = u2Res.rows[0].id;

    // -------------------------------------------------------------------------
    // 3. Index One Scheduled Email & Search Verifications
    // -------------------------------------------------------------------------
    console.log('3. Indexing scheduled campaign for User 1...');
    // Create Campaign
    const campRes = await pool.query<CampaignRow>(
      `INSERT INTO campaigns (user_id, subject, body, hourly_limit, status) 
       VALUES ($1, 'Outbound Job Alert: Software Developer Role', 'Hello {{name}}, we have a matching backend job for you.', 5, 'sending') 
       RETURNING *`,
      [user1Id]
    );
    const campaignA = campRes.rows[0];

    // Create Recipient
    const recRes = await pool.query<RecipientRow>(
      `INSERT INTO recipients (campaign_id, email, name, status) 
       VALUES ($1, 'alice.search@example.com', 'Alice Searcher', 'pending') 
       RETURNING *`,
      [campaignA.id]
    );
    const recipientA = recRes.rows[0];

    // Index Scheduled Emails
    await indexScheduledEmails(campaignA, [recipientA]);

    // Give Elasticsearch half a second to refresh (though bulk refresh is enabled)
    await delay(500);

    // 4. Search by subject
    console.log('4. Searching by subject...');
    const searchSub = await searchEmails(user1Id, 'Developer');
    if (searchSub.count >= 1 && searchSub.results[0].subject.includes('Software Developer')) {
      console.log('  ✅ PASS: Found scheduled email by subject.');
    } else {
      console.error('  ❌ FAIL: Could not search by subject.');
    }

    // 5. Search by recipient email
    console.log('5. Searching by recipient email...');
    const searchEmail = await searchEmails(user1Id, 'alice.search');
    if (searchEmail.count >= 1 && searchEmail.results[0].recipientEmail === 'alice.search@example.com') {
      console.log('  ✅ PASS: Found scheduled email by recipient email.');
    } else {
      console.error('  ❌ FAIL: Could not search by recipient email.');
    }

    // 6. Search by recipient name
    console.log('6. Searching by recipient name...');
    const searchName = await searchEmails(user1Id, 'Alice');
    if (searchName.count >= 1 && searchName.results[0].recipientName === 'Alice Searcher') {
      console.log('  ✅ PASS: Found scheduled email by recipient name.');
    } else {
      console.error('  ❌ FAIL: Could not search by recipient name.');
    }

    // 7. Filter by status
    console.log('7. Filtering by status...');
    const filterSched = await searchEmails(user1Id, undefined, { status: 'scheduled' });
    if (filterSched.count >= 1 && filterSched.results[0].status === 'scheduled') {
      console.log('  ✅ PASS: Filtered successfully by scheduled status.');
    } else {
      console.error('  ❌ FAIL: Filter by status returned incorrect count or status.');
    }

    // 8. Search only returns authenticated user's records
    console.log('8. Verifying search returns authenticated user\'s records...');
    const u1Search = await searchEmails(user1Id, 'Alice');
    if (u1Search.count === 1) {
      console.log('  ✅ PASS: User 1 sees exactly their own record.');
    } else {
      console.error(`  ❌ FAIL: User 1 search returned ${u1Search.count} records (expected 1).`);
    }

    // 9. Another user cannot see the first user's records
    console.log('9. Verifying User 2 cannot access User 1\'s emails...');
    const u2Search = await searchEmails(user2Id, 'Alice');
    if (u2Search.count === 0) {
      console.log('  ✅ PASS: User 2 isolated successfully (returned 0 matching records).');
    } else {
      console.error(`  ❌ FAIL: User 2 accessed User 1\'s data (returned ${u2Search.count} records).`);
    }

    // 10. Index sent status
    console.log('10. Indexing email sent status...');
    await indexEmailAsSent(campaignA, recipientA, new Date());
    await delay(500);

    const checkSent = await searchEmails(user1Id, 'Alice');
    if (checkSent.count === 1 && checkSent.results[0].status === 'sent' && checkSent.results[0].sentAt !== null) {
      console.log('  ✅ PASS: Document successfully updated to status="sent" with sentAt timestamp.');
    } else {
      console.error('  ❌ FAIL: Document status or sentAt was not updated correctly.');
    }

    // 11. Repeated indexing does not create duplicate documents
    console.log('11. Verifying idempotency of repeated indexing...');
    await indexEmailAsSent(campaignA, recipientA, new Date());
    await delay(500);

    const checkDup = await searchEmails(user1Id, 'Alice');
    if (checkDup.count === 1) {
      console.log('  ✅ PASS: Repeated indexing did not create duplicate documents (Count is 1).');
    } else {
      console.error(`  ❌ FAIL: Duplicate documents detected! Count: ${checkDup.count}`);
    }

    // 12. Search pagination works
    console.log('12. Verifying search pagination...');
    // Create 3 additional recipients
    const batchRecs = [];
    for (let idx = 1; idx <= 3; idx++) {
      const br = await pool.query<RecipientRow>(
        `INSERT INTO recipients (campaign_id, email, name, status) 
         VALUES ($1, $2, $3, 'pending') 
         RETURNING *`,
        [campaignA.id, `batch-${idx}@example.com`, `Batch User ${idx}`]
      );
      batchRecs.push(br.rows[0]);
    }
    await indexScheduledEmails(campaignA, batchRecs);
    await delay(500);

    // Search with page=1, limit=2
    const page1 = await searchEmails(user1Id, undefined, undefined, { page: 1, limit: 2 });
    // Search with page=2, limit=2
    const page2 = await searchEmails(user1Id, undefined, undefined, { page: 2, limit: 2 });

    if (page1.count === 4 && page1.results.length === 2 && page2.results.length === 2) {
      console.log('  ✅ PASS: Pagination working correctly (total = 4, page 1 size = 2, page 2 size = 2).');
    } else {
      console.error('  ❌ FAIL: Pagination check failed:', {
        total: page1.count,
        page1Len: page1.results.length,
        page2Len: page2.results.length
      });
    }

    // 13. Reindex script works
    console.log('13. Verifying reindex recovery script...');
    // Delete all records from ES first using correct query parameter directly at root
    await esClient.deleteByQuery({
      index: INDEX_NAME,
      refresh: true,
      query: {
        match_all: {}
      }
    });
    
    // Check they are gone
    const checkClear = await searchEmails(user1Id);
    if (checkClear.count !== 0) {
      console.warn('  ⚠️ ES did not clear test data completely, proceeding.');
    }

    // Run the reindexing script via child process
    console.log('  Running npm run search:reindex...');
    const reindexOutput = await runCommandAsync('npm run search:reindex');
    console.log(reindexOutput);

    // Search again to confirm they returned
    const checkReindexed = await searchEmails(user1Id);
    if (checkReindexed.count === 4) {
      console.log('  ✅ PASS: Reindex script executed successfully and restored all documents.');
    } else {
      console.error(`  ❌ FAIL: Reindexed count is ${checkReindexed.count} (expected 4).`);
    }

    // 14. Elasticsearch outage safety (no exception propagation to DB layer)
    console.log('14. Verifying Elasticsearch outage safety...');
    
    // Mock bulk indexing to throw a connection error
    const originalBulk = esClient.bulk;
    esClient.bulk = async () => {
      throw new Error('Connection refused: Elasticsearch node is offline');
    };

    // Attempt to write a campaign
    const testCampOutage = await pool.query<CampaignRow>(
      `INSERT INTO campaigns (user_id, subject, body, hourly_limit, status) 
       VALUES ($1, 'Outage Test', 'Body text', 5, 'draft') 
       RETURNING *`,
      [user1Id]
    );

    const testRecOutage = await pool.query<RecipientRow>(
      `INSERT INTO recipients (campaign_id, email, name, status) 
       VALUES ($1, 'outage@example.com', 'Outage User', 'pending') 
       RETURNING *`,
      [testCampOutage.rows[0].id]
    );

    try {
      // Simulate indexing call (which will fail because bulk is stubbed to throw)
      await indexScheduledEmails(testCampOutage.rows[0], [testRecOutage.rows[0]]);
      console.log('  ✅ PASS: Indexing failure was isolated and did not throw exception to caller.');
    } catch (err: any) {
      console.error('  ❌ FAIL: Indexing failure threw exception:', err.message);
    } finally {
      // Restore client stub
      esClient.bulk = originalBulk;
    }

  } catch (error: any) {
    console.error('❌ Integration test run crashed:', error);
  } finally {
    console.log('\n🧹 Cleaning up test data...');
    if (user1Id || user2Id) {
      await cleanupTestData(user1Id, user2Id);
    }
    await pool.end();
    console.log('🎉 Elasticsearch tests finished.');
    process.exit(0);
  }
}

main();
