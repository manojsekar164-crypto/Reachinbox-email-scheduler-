/**
 * src/services/campaignService.ts
 *
 * All campaign + recipient business logic.
 *
 * Key design decisions:
 *  - createCampaignWithRecipients runs inside a single PostgreSQL transaction
 *    so that a partial failure never leaves orphaned campaign rows.
 *  - Every ownership query appends AND user_id = $N, so users can never
 *    read, modify, or delete another user's data.
 *  - Duplicate recipient email detection is case-insensitive and happens
 *    before the transaction opens (fast fail, no DB round-trip needed).
 *  - Email addresses are normalised to trimmed lowercase before insertion.
 */

import { db } from '../db/postgres';
import { indexScheduledEmails } from './searchService';
import { scheduleEmailJobs } from './schedulingService';
import { notifyCampaignCreated } from './slackService';
import {
  CampaignRow,
  CampaignStatus,
  RecipientRow,
} from '../types/db.types';

// =============================================================================
// Input / output types
// =============================================================================

export interface RecipientInput {
  email: string;
  name?: string;
}

export interface CreateCampaignInput {
  senderId?: string;
  subject: string;
  body: string;
  scheduledAt?: Date | null;
  hourlyLimit: number;
  recipients: RecipientInput[];
}

export interface UpdateCampaignInput {
  senderId?: string;
  subject?: string;
  body?: string;
  scheduledAt?: Date | null;
  hourlyLimit?: number;
  status?: CampaignStatus;
}

export interface CampaignWithRecipients extends CampaignRow {
  recipients: RecipientRow[];
}

// =============================================================================
// Create campaign + recipients (atomic transaction)
// =============================================================================

export async function createCampaignWithRecipients(
  userId: string,
  input: CreateCampaignInput,
): Promise<CampaignWithRecipients> {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 0. Verify the sender exists and belongs to the user if provided
    if (input.senderId) {
      const senderCheck = await client.query(
        'SELECT id FROM senders WHERE id = $1 AND user_id = $2',
        [input.senderId, userId]
      );
      if (senderCheck.rows.length === 0) {
        throw new Error('Invalid sender: Sender not found or does not belong to the user.');
      }
    }

    // 1. Insert the campaign row
    const initialStatus: CampaignStatus = input.scheduledAt ? 'scheduled' : 'sending';
    const { rows: campaignRows } = await client.query<CampaignRow>(
      `INSERT INTO campaigns (user_id, sender_id, subject, body, scheduled_at, hourly_limit, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        userId,
        input.senderId ?? null,
        input.subject,
        input.body,
        input.scheduledAt ?? null,
        input.hourlyLimit,
        initialStatus,
      ],
    );
    const campaign = campaignRows[0]!;

    // 2. Insert each recipient (email already normalised by the controller)
    const recipients: RecipientRow[] = [];
    for (const r of input.recipients) {
      const { rows: recipientRows } = await client.query<RecipientRow>(
        `INSERT INTO recipients (campaign_id, email, name)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [campaign.id, r.email, r.name ?? null],
      );
      recipients.push(recipientRows[0]!);
    }

    await client.query('COMMIT');

    // Index the scheduled emails in Elasticsearch (safely, catching all errors)
    try {
      await indexScheduledEmails(campaign, recipients);
    } catch (esErr: any) {
      console.error(`❌ [Elasticsearch] Scheduled email indexing failed: ${esErr.message}`);
    }

    // Enqueue BullMQ delayed jobs for each recipient (Phase 9E).
    // Errors here are logged but do NOT throw — the campaign is already committed
    // in PostgreSQL and must not be rolled back due to a transient queue error.
    try {
      await scheduleEmailJobs(campaign, recipients);
    } catch (queueErr: any) {
      console.error(
        `❌ [Scheduler] Failed to enqueue jobs for campaign ${campaign.id}: ${queueErr.message}`,
      );
    }

    // Trigger Slack notification for campaign launch (isolated and non-blocking)
    try {
      await notifyCampaignCreated(
        campaign.user_id,
        campaign.subject,
        recipients.length,
        campaign.hourly_limit,
      );
    } catch (slackErr: any) {
      console.warn(`⚠️ [Slack] Failed to send launch notification: ${slackErr.message}`);
    }

    return { ...campaign, recipients };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    // Always release back to the pool – even on error.
    client.release();
  }
}

// =============================================================================
// List campaigns for one user
// =============================================================================

export async function listCampaignsByUser(
  userId: string,
): Promise<CampaignRow[]> {
  const { rows } = await db.query<CampaignRow>(
    `SELECT * FROM campaigns WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

// =============================================================================
// Get one campaign + recipients (ownership enforced)
// =============================================================================

export async function getCampaignWithRecipients(
  campaignId: string,
  userId: string,
): Promise<CampaignWithRecipients | null> {
  const { rows: campaignRows } = await db.query<CampaignRow>(
    `SELECT * FROM campaigns WHERE id = $1 AND user_id = $2`,
    [campaignId, userId],
  );
  const campaign = campaignRows[0];
  if (!campaign) return null;

  const { rows: recipientRows } = await db.query<RecipientRow>(
    `SELECT * FROM recipients WHERE campaign_id = $1 ORDER BY created_at`,
    [campaignId],
  );
  return { ...campaign, recipients: recipientRows };
}

// =============================================================================
// Update campaign (ownership enforced, dynamic safe SQL)
// =============================================================================

export async function updateCampaign(
  campaignId: string,
  userId: string,
  updates: UpdateCampaignInput,
): Promise<CampaignRow | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.senderId !== undefined) {
    // Verify sender ownership first
    const senderCheck = await db.query(
      'SELECT id FROM senders WHERE id = $1 AND user_id = $2',
      [updates.senderId, userId]
    );
    if (senderCheck.rows.length === 0) {
      throw new Error('Invalid sender: Sender not found or does not belong to the user.');
    }
    setClauses.push(`sender_id = $${idx++}`);
    values.push(updates.senderId);
  }
  if (updates.subject !== undefined) {
    setClauses.push(`subject = $${idx++}`);
    values.push(updates.subject);
  }
  if (updates.body !== undefined) {
    setClauses.push(`body = $${idx++}`);
    values.push(updates.body);
  }
  if (updates.scheduledAt !== undefined) {
    setClauses.push(`scheduled_at = $${idx++}`);
    values.push(updates.scheduledAt);
  }
  if (updates.hourlyLimit !== undefined) {
    setClauses.push(`hourly_limit = $${idx++}`);
    values.push(updates.hourlyLimit);
  }
  if (updates.status !== undefined) {
    setClauses.push(`status = $${idx++}`);
    values.push(updates.status);
  }

  if (setClauses.length === 0) {
    // Caller must check for null and return 400
    return null;
  }

  // Append the always-updated timestamp and ownership filters
  setClauses.push(`updated_at = NOW()`);

  values.push(campaignId);  // $idx
  values.push(userId);      // $idx+1

  const sql = `
    UPDATE campaigns
    SET ${setClauses.join(', ')}
    WHERE id = $${idx++} AND user_id = $${idx}
    RETURNING *
  `;

  const { rows } = await db.query<CampaignRow>(sql, values);
  return rows[0] ?? null;
}

// =============================================================================
// Delete campaign (ownership enforced; cascade handles recipients + logs)
// =============================================================================

export async function deleteCampaignForUser(
  campaignId: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM campaigns WHERE id = $1 AND user_id = $2`,
    [campaignId, userId],
  );
  return (rowCount ?? 0) > 0;
}

// =============================================================================
// Get recipients for a campaign (ownership enforced via campaign lookup)
// =============================================================================

export async function getRecipientsForCampaign(
  campaignId: string,
  userId: string,
): Promise<any[] | null> {
  // Verify ownership first
  const { rows: campaignRows } = await db.query<CampaignRow>(
    `SELECT id FROM campaigns WHERE id = $1 AND user_id = $2`,
    [campaignId, userId],
  );
  if (!campaignRows[0]) return null;

  const { rows } = await db.query(
    `SELECT 
       r.id,
       r.campaign_id,
       r.email,
       r.name,
       r.created_at,
       COALESCE(el.status, 'queued') as status,
       el.error_message,
       el.sent_at
     FROM recipients r
     LEFT JOIN (
       SELECT DISTINCT ON (recipient_id) recipient_id, status, error_message, sent_at
       FROM email_logs
       WHERE campaign_id = $1
       ORDER BY recipient_id, created_at DESC
     ) el ON el.recipient_id = r.id
     WHERE r.campaign_id = $1
     ORDER BY r.created_at`,
    [campaignId],
  );
  return rows;
}