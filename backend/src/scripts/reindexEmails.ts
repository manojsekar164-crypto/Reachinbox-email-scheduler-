import { db as pool } from '../db/postgres';
import { esClient } from '../search/elasticsearch';
import { ensureIndex } from '../services/searchService';
import dotenv from 'dotenv';
import path from 'path';

// Load environmental variables
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const INDEX_NAME = process.env.ELASTICSEARCH_INDEX || 'reachinbox-emails';

async function runReindex() {
  console.log('🔄 Starting Elasticsearch Reindexing process...\n');

  try {
    // 1. Ensure the index and its mappings exist
    await ensureIndex();

    // 2. Query all scheduled and sent email records from Postgres
    console.log('📖 Querying all email records from PostgreSQL...');
    const queryStr = `
      SELECT 
        r.id AS recipient_id,
        r.campaign_id,
        r.email AS recipient_email,
        r.name AS recipient_name,
        c.user_id,
        c.subject,
        c.body,
        c.scheduled_at,
        c.created_at AS campaign_created_at,
        c.sender_id,
        s.email AS sender_email,
        s.name AS sender_name,
        el.sent_at
      FROM recipients r
      JOIN campaigns c ON r.campaign_id = c.id
      LEFT JOIN senders s ON c.sender_id = s.id
      LEFT JOIN email_logs el ON el.campaign_id = c.id AND el.recipient_id = r.id AND el.status = 'sent';
    `;

    const { rows } = await pool.query(queryStr);
    const totalRecords = rows.length;
    console.log(`Found ${totalRecords} email records to reindex.`);

    if (totalRecords === 0) {
      console.log('✅ Index is already up-to-date (no records to import).');
      process.exit(0);
    }

    let attempted = 0;
    let indexed = 0;
    let failed = 0;

    const batchSize = 100;

    // 3. Batch process documents to prevent memory bloat and execute bulk requests
    for (let k = 0; k < rows.length; k += batchSize) {
      const batch = rows.slice(k, k + batchSize);
      attempted += batch.length;

      const bulkOps: any[] = [];
      const batchDocIds: string[] = [];

      for (const row of batch) {
        const docId = `${row.campaign_id}_${row.recipient_id}`;
        batchDocIds.push(docId);

        const doc = {
          id: docId,
          campaignId: row.campaign_id,
          recipientId: row.recipient_id,
          userId: row.user_id,
          recipientEmail: row.recipient_email,
          recipientName: row.recipient_name || '',
          subject: row.subject,
          body: row.body,
          status: row.sent_at ? 'sent' : 'scheduled',
          scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : new Date(row.campaign_created_at).toISOString(),
          sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
          createdAt: new Date(row.campaign_created_at).toISOString(),
          updatedAt: new Date().toISOString(),
          senderId: row.sender_id || null,
          senderEmail: row.sender_email || null,
          senderName: row.sender_name || null
        };


        bulkOps.push({ index: { _index: INDEX_NAME, _id: docId } });
        bulkOps.push(doc);
      }

      try {
        const response = await esClient.bulk({ refresh: true, operations: bulkOps });
        if (response.errors) {
          // Identify individual document failures inside the bulk request
          response.items.forEach((item: any, idx: number) => {
            const op = item.index || item.create || item.update || item.delete;
            if (op && op.error) {
              failed++;
              console.error(`❌ Failed to index document ID ${batchDocIds[idx]}:`, op.error);
            } else {
              indexed++;
            }
          });
        } else {
          indexed += batch.length;
        }
      } catch (bulkErr: any) {
        failed += batch.length;
        console.error(`❌ Bulk batch at offset ${k} failed completely:`, bulkErr.message);
      }
    }

    console.log('\n==================================');
    console.log('📊 REINDEX COMPLETE');
    console.log(`Documents attempted: ${attempted}`);
    console.log(`Documents indexed:   ${indexed}`);
    console.log(`Documents failed:    ${failed}`);
    console.log('==================================\n');

    process.exit(failed === 0 ? 0 : 1);
  } catch (error: any) {
    console.error('❌ Reindex script failed with error:', error.message);
    process.exit(1);
  } finally {
    // Terminate DB connections
    await pool.end();
  }
}

runReindex();
