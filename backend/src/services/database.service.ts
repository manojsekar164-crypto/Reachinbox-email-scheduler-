/**
 * src/services/database.service.ts
 *
 * Thin, typed service layer for CRUD operations.
 * All queries use parameterised placeholders ($1, $2…) – never string
 * interpolation – to prevent SQL injection.
 *
 * Import `db` from the central postgres module; never create ad-hoc pools.
 */

import { db } from '../db/postgres';
import {
  UserRow,
  CampaignRow,
  CampaignStatus,
  RecipientRow,
  RecipientStatus,
  EmailLogRow,
  EmailLogStatus,
} from '../types/db.types';

// =============================================================================
// USERS
// =============================================================================

export async function createUser(
  email: string,
  name?: string,
  googleId?: string,
): Promise<UserRow> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (email, name, google_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [email, name ?? null, googleId ?? null],
  );
  return rows[0]!;
}

export async function getUserById(id: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    'SELECT * FROM users WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    'SELECT * FROM users WHERE email = $1',
    [email],
  );
  return rows[0] ?? null;
}

export async function deleteUser(id: string): Promise<void> {
  await db.query('DELETE FROM users WHERE id = $1', [id]);
}

// =============================================================================
// CAMPAIGNS
// =============================================================================

export async function createCampaign(
  userId: string,
  subject: string,
  body: string,
  scheduledAt?: Date,
  hourlyLimit = 5,
): Promise<CampaignRow> {
  const { rows } = await db.query<CampaignRow>(
    `INSERT INTO campaigns (user_id, subject, body, scheduled_at, hourly_limit)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, subject, body, scheduledAt ?? null, hourlyLimit],
  );
  return rows[0]!;
}

export async function getCampaignById(id: string): Promise<CampaignRow | null> {
  const { rows } = await db.query<CampaignRow>(
    'SELECT * FROM campaigns WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export async function getCampaignsByUser(userId: string): Promise<CampaignRow[]> {
  const { rows } = await db.query<CampaignRow>(
    'SELECT * FROM campaigns WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );
  return rows;
}

export async function updateCampaignStatus(
  id: string,
  status: CampaignStatus,
): Promise<CampaignRow | null> {
  const { rows } = await db.query<CampaignRow>(
    `UPDATE campaigns SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [status, id],
  );
  return rows[0] ?? null;
}

export async function deleteCampaign(id: string): Promise<void> {
  await db.query('DELETE FROM campaigns WHERE id = $1', [id]);
}

// =============================================================================
// RECIPIENTS
// =============================================================================

export async function createRecipient(
  campaignId: string,
  email: string,
  name?: string,
): Promise<RecipientRow> {
  const { rows } = await db.query<RecipientRow>(
    `INSERT INTO recipients (campaign_id, email, name)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [campaignId, email, name ?? null],
  );
  return rows[0]!;
}

export async function getRecipientById(id: string): Promise<RecipientRow | null> {
  const { rows } = await db.query<RecipientRow>(
    'SELECT * FROM recipients WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export async function getRecipientsByCampaign(
  campaignId: string,
): Promise<RecipientRow[]> {
  const { rows } = await db.query<RecipientRow>(
    'SELECT * FROM recipients WHERE campaign_id = $1 ORDER BY created_at',
    [campaignId],
  );
  return rows;
}

export async function updateRecipientStatus(
  id: string,
  status: RecipientStatus,
): Promise<RecipientRow | null> {
  const { rows } = await db.query<RecipientRow>(
    `UPDATE recipients SET status = $1 WHERE id = $2 RETURNING *`,
    [status, id],
  );
  return rows[0] ?? null;
}

export async function deleteRecipient(id: string): Promise<void> {
  await db.query('DELETE FROM recipients WHERE id = $1', [id]);
}

// =============================================================================
// EMAIL LOGS
// =============================================================================

export async function createEmailLog(
  campaignId: string,
  recipientId: string,
  status: EmailLogStatus,
  sentAt?: Date,
  errorMessage?: string,
): Promise<EmailLogRow> {
  const { rows } = await db.query<EmailLogRow>(
    `INSERT INTO email_logs (campaign_id, recipient_id, status, sent_at, error_message)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [campaignId, recipientId, status, sentAt ?? null, errorMessage ?? null],
  );
  return rows[0]!;
}

export async function getEmailLogsByCampaign(
  campaignId: string,
): Promise<EmailLogRow[]> {
  const { rows } = await db.query<EmailLogRow>(
    'SELECT * FROM email_logs WHERE campaign_id = $1 ORDER BY created_at DESC',
    [campaignId],
  );
  return rows;
}

export async function getEmailLogsByRecipient(
  recipientId: string,
): Promise<EmailLogRow[]> {
  const { rows } = await db.query<EmailLogRow>(
    'SELECT * FROM email_logs WHERE recipient_id = $1 ORDER BY created_at DESC',
    [recipientId],
  );
  return rows;
}

export async function deleteEmailLog(id: string): Promise<void> {
  await db.query('DELETE FROM email_logs WHERE id = $1', [id]);
}

// =============================================================================
// HEALTH CHECK
// =============================================================================

/**
 * Verifies that the PostgreSQL connection is alive.
 * Returns true on success, throws on failure.
 */
export async function checkDbHealth(): Promise<boolean> {
  await db.query('SELECT 1');
  return true;
}
