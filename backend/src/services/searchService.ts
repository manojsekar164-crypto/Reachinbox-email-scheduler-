import { esClient } from '../search/elasticsearch';
import { CampaignRow, RecipientRow } from '../types/db.types';
import { db } from '../db/postgres';

const INDEX_NAME = process.env.ELASTICSEARCH_INDEX || 'reachinbox-emails';

export interface EmailSearchDoc {
  id: string; // campaignId_recipientId (stable, deterministic unique ID)
  campaignId: string;
  recipientId: string;
  userId: string;
  recipientEmail: string;
  recipientName: string;
  subject: string;
  body: string;
  status: 'scheduled' | 'sent';
  scheduledAt: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
  senderId: string | null;
  senderEmail: string | null;
  senderName: string | null;
}

/**
 * Checks if the Elasticsearch index exists and creates it with mappings if it does not.
 * Runs on startup, safe to execute multiple times.
 */
export async function ensureIndex(): Promise<void> {
  try {
    const exists = await esClient.indices.exists({ index: INDEX_NAME });
    if (!exists) {
      await esClient.indices.create({
        index: INDEX_NAME,
        mappings: {
          properties: {
            id: { type: 'keyword' },
            campaignId: { type: 'keyword' },
            recipientId: { type: 'keyword' },
            userId: { type: 'keyword' },
            recipientEmail: {
              type: 'text',
              fields: {
                keyword: { type: 'keyword', ignore_above: 256 }
              }
            },
            recipientName: { type: 'text' },
            subject: { type: 'text' },
            body: { type: 'text' },
            status: { type: 'keyword' },
            scheduledAt: { type: 'date' },
            sentAt: { type: 'date' },
            createdAt: { type: 'date' },
            updatedAt: { type: 'date' },
            senderId: { type: 'keyword' },
            senderEmail: {
              type: 'text',
              fields: {
                keyword: { type: 'keyword', ignore_above: 256 }
              }
            },
            senderName: { type: 'text' }
          }
        }
      });
      console.log(`✅ [Elasticsearch] Created index: ${INDEX_NAME}`);
    } else {
      console.log(`ℹ️  [Elasticsearch] Index ${INDEX_NAME} already exists.`);
    }
  } catch (error: any) {
    // Gracefully handle connection issues so application startup isn't blocked
    console.error(`❌ [Elasticsearch] Failed to ensure index: ${error.message}`);
  }
}

/**
 * Bulk-indexes scheduled email records when a campaign is created.
 */
export async function indexScheduledEmails(
  campaign: CampaignRow,
  recipients: RecipientRow[]
): Promise<void> {
  try {
    let senderEmail: string | null = null;
    let senderName: string | null = null;
    if (campaign.sender_id) {
      const senderRes = await db.query('SELECT email, name FROM senders WHERE id = $1', [campaign.sender_id]);
      if (senderRes.rows.length > 0) {
        senderEmail = senderRes.rows[0].email;
        senderName = senderRes.rows[0].name;
      }
    }

    const operations = recipients.flatMap((recipient) => {
      const docId = `${campaign.id}_${recipient.id}`;
      const doc: EmailSearchDoc = {
        id: docId,
        campaignId: campaign.id,
        recipientId: recipient.id,
        userId: campaign.user_id,
        recipientEmail: recipient.email,
        recipientName: recipient.name || '',
        subject: campaign.subject,
        body: campaign.body,
        status: 'scheduled',
        scheduledAt: campaign.scheduled_at ? new Date(campaign.scheduled_at).toISOString() : new Date(campaign.created_at).toISOString(),
        sentAt: null,
        createdAt: new Date(campaign.created_at).toISOString(),
        updatedAt: new Date(campaign.created_at).toISOString(),
        senderId: campaign.sender_id || null,
        senderEmail,
        senderName
      };

      return [
        { index: { _index: INDEX_NAME, _id: docId } },
        doc
      ];
    });

    if (operations.length > 0) {
      const response = await esClient.bulk({ refresh: true, operations });
      if (response.errors) {
        console.error('❌ [Elasticsearch] Bulk indexing encountered errors:');
        response.items.forEach((item: any) => {
          const op = item.index || item.create;
          if (op && op.error) {
            console.error(`  - Document ID ${op._id} failed:`, op.error);
          }
        });
      } else {
        console.log(`✅ [Elasticsearch] Bulk-indexed ${recipients.length} scheduled emails.`);
      }
    }
  } catch (error: any) {
    // Isolate error completely from PostgreSQL flow
    console.error(`❌ [Elasticsearch] Indexing failed: ${error.message}`);
  }
}

/**
 * Idempotently indexes/updates an email document to 'sent' status.
 */
export async function indexEmailAsSent(
  campaign: CampaignRow,
  recipient: RecipientRow,
  sentAt: Date
): Promise<void> {
  let senderEmail: string | null = null;
  let senderName: string | null = null;
  if (campaign.sender_id) {
    try {
      const senderRes = await db.query('SELECT email, name FROM senders WHERE id = $1', [campaign.sender_id]);
      if (senderRes.rows.length > 0) {
        senderEmail = senderRes.rows[0].email;
        senderName = senderRes.rows[0].name;
      }
    } catch (err) {
      console.error('❌ Failed to fetch sender for ES indexing:', err);
    }
  }

  const docId = `${campaign.id}_${recipient.id}`;
  const doc: EmailSearchDoc = {
    id: docId,
    campaignId: campaign.id,
    recipientId: recipient.id,
    userId: campaign.user_id,
    recipientEmail: recipient.email,
    recipientName: recipient.name || '',
    subject: campaign.subject,
    body: campaign.body,
    status: 'sent',
    scheduledAt: campaign.scheduled_at ? new Date(campaign.scheduled_at).toISOString() : new Date(campaign.created_at).toISOString(),
    sentAt: sentAt.toISOString(),
    createdAt: new Date(campaign.created_at).toISOString(),
    updatedAt: new Date().toISOString(),
    senderId: campaign.sender_id || null,
    senderEmail,
    senderName
  };

  try {
    await esClient.index({
      index: INDEX_NAME,
      id: docId,
      refresh: true,
      document: doc
    });
    console.log(`✅ [Elasticsearch] Indexed sent email: ${docId}`);
  } catch (error: any) {
    // Isolate error completely from core delivery flow
    console.error(`❌ [Elasticsearch] Indexing failed: ${error.message}`);
  }
}

/**
 * Securely searches emails scoped to the authenticated user ID.
 */
export async function searchEmails(
  userId: string,
  q?: string,
  filters?: {
    status?: string;
    scheduledAtStart?: string;
    scheduledAtEnd?: string;
    sentAtStart?: string;
    sentAtEnd?: string;
  },
  pagination?: {
    page?: number;
    limit?: number;
  }
): Promise<{ count: number; results: any[] }> {
  const page = Math.max(1, pagination?.page || 1);
  const limit = Math.min(100, Math.max(1, pagination?.limit || 20));
  const from = (page - 1) * limit;

  // Build query starting with user isolation
  const mustClauses: any[] = [
    { term: { userId } }
  ];

  if (q && q.trim() !== '') {
    mustClauses.push({
      multi_match: {
        query: q,
        fields: ['subject', 'body', 'recipientName', 'recipientEmail'],
        type: 'best_fields',
        fuzziness: 'AUTO'
      }
    });
  }

  const filterClauses: any[] = [];
  if (filters?.status) {
    filterClauses.push({ term: { status: filters.status } });
  }

  if (filters?.scheduledAtStart || filters?.scheduledAtEnd) {
    const range: any = {};
    if (filters.scheduledAtStart) range.gte = filters.scheduledAtStart;
    if (filters.scheduledAtEnd) range.lte = filters.scheduledAtEnd;
    filterClauses.push({ range: { scheduledAt: range } });
  }

  if (filters?.sentAtStart || filters?.sentAtEnd) {
    const range: any = {};
    if (filters.sentAtStart) range.gte = filters.sentAtStart;
    if (filters.sentAtEnd) range.lte = filters.sentAtEnd;
    filterClauses.push({ range: { sentAt: range } });
  }

  // Sort: relevance if query string is present, otherwise newest first
  let sort: any = undefined;
  if (!q || q.trim() === '') {
    sort = [{ createdAt: { order: 'desc' } }];
  }

  try {
    const searchResponse = await esClient.search({
      index: INDEX_NAME,
      from,
      size: limit,
      query: {
        bool: {
          must: mustClauses,
          filter: filterClauses
        }
      },
      sort
    });

    const total = typeof searchResponse.hits.total === 'number'
      ? searchResponse.hits.total
      : (searchResponse.hits.total as any)?.value || 0;

    const results = searchResponse.hits.hits.map((hit: any) => {
      const source = hit._source;
      return {
        id: source.id,
        campaignId: source.campaignId,
        recipientId: source.recipientId,
        recipientEmail: source.recipientEmail,
        recipientName: source.recipientName,
        subject: source.subject,
        status: source.status,
        scheduledAt: source.scheduledAt,
        sentAt: source.sentAt,
        senderId: source.senderId || null,
        senderEmail: source.senderEmail || null,
        senderName: source.senderName || null
      };
    });

    return { count: total, results };
  } catch (error: any) {
    console.warn(`⚠️ [Elasticsearch] Unavailable (${error.message}). Falling back to PostgreSQL email_logs query...`);
    return await searchEmailsPostgresFallback(userId, q, filters, pagination);
  }
}

/**
 * Robust PostgreSQL fallback for search and sent logs when Elasticsearch is offline.
 */
async function searchEmailsPostgresFallback(
  userId: string,
  q?: string,
  filters?: {
    status?: string;
    scheduledAtStart?: string;
    scheduledAtEnd?: string;
    sentAtStart?: string;
    sentAtEnd?: string;
  },
  pagination?: {
    page?: number;
    limit?: number;
  }
): Promise<{ count: number; results: any[] }> {
  const page = Math.max(1, pagination?.page || 1);
  const limit = Math.min(100, Math.max(1, pagination?.limit || 20));
  const offset = (page - 1) * limit;

  try {
    if (filters?.status === 'scheduled') {
      // Query scheduled recipients that have not been marked sent yet
      const query = `
        SELECT 
          r.id as id,
          c.id as "campaignId",
          r.id as "recipientId",
          r.email as "recipientEmail",
          r.name as "recipientName",
          c.subject,
          'scheduled' as status,
          c.scheduled_at as "scheduledAt",
          NULL as "sentAt",
          r.created_at as "createdAt",
          s.id as "senderId",
          s.email as "senderEmail",
          s.name as "senderName"
        FROM recipients r
        JOIN campaigns c ON c.id = r.campaign_id
        LEFT JOIN senders s ON s.id = c.sender_id
        WHERE c.user_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM email_logs el 
          WHERE el.campaign_id = c.id AND el.recipient_id = r.id AND el.status = 'sent'
        )
        ${q ? 'AND (c.subject ILIKE $2 OR r.email ILIKE $2)' : ''}
        ORDER BY r.created_at DESC
        LIMIT $${q ? 3 : 2} OFFSET $${q ? 4 : 3}
      `;
      const params: any[] = [userId];
      if (q) params.push(`%${q}%`);
      params.push(limit, offset);

      const countQuery = `
        SELECT COUNT(*) as total
        FROM recipients r
        JOIN campaigns c ON c.id = r.campaign_id
        WHERE c.user_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM email_logs el 
          WHERE el.campaign_id = c.id AND el.recipient_id = r.id AND el.status = 'sent'
        )
        ${q ? 'AND (c.subject ILIKE $2 OR r.email ILIKE $2)' : ''}
      `;
      const countParams = q ? [userId, `%${q}%`] : [userId];
      const countRes = await db.query(countQuery, countParams);
      const total = parseInt(countRes.rows[0]?.total || '0', 10);
      const rowsRes = await db.query(query, params);

      return { count: total, results: rowsRes.rows };
    }

    // Default: Query email_logs for sent/failed emails
    let baseWhere = 'WHERE c.user_id = $1';
    const params: any[] = [userId];

    if (filters?.status) {
      params.push(filters.status);
      baseWhere += ` AND el.status = $${params.length}`;
    }

    if (q && q.trim()) {
      params.push(`%${q.trim()}%`);
      baseWhere += ` AND (c.subject ILIKE $${params.length} OR r.email ILIKE $${params.length})`;
    }

    const countQuery = `
      SELECT COUNT(*) as total 
      FROM email_logs el
      JOIN campaigns c ON c.id = el.campaign_id
      JOIN recipients r ON r.id = el.recipient_id
      ${baseWhere}
    `;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0]?.total || '0', 10);

    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const dataQuery = `
      SELECT 
        el.id,
        el.campaign_id as "campaignId",
        el.recipient_id as "recipientId",
        r.email as "recipientEmail",
        r.name as "recipientName",
        c.subject,
        el.status,
        c.scheduled_at as "scheduledAt",
        el.sent_at as "sentAt",
        el.created_at as "createdAt",
        s.id as "senderId",
        s.email as "senderEmail",
        s.name as "senderName"
      FROM email_logs el
      JOIN campaigns c ON c.id = el.campaign_id
      JOIN recipients r ON r.id = el.recipient_id
      LEFT JOIN senders s ON s.id = el.sender_id
      ${baseWhere}
      ORDER BY el.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;
    const rowsRes = await db.query(dataQuery, params);

    return { count: total, results: rowsRes.rows };
  } catch (pgErr: any) {
    console.error(`❌ [Database] PostgreSQL search fallback failed: ${pgErr.message}`);
    return { count: 0, results: [] };
  }
}

/**
 * Pings the Elasticsearch cluster to check its availability.
 */
export async function checkElasticsearchHealth(): Promise<boolean> {
  try {
    await esClient.ping();
    return true;
  } catch (err: any) {
    console.error(`❌ [Elasticsearch] Health ping failed: ${err.message}`);
    return false;
  }
}
