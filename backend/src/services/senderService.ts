/**
 * src/services/senderService.ts
 *
 * All sender business logic and database access.
 *
 * Key features:
 *  - Raw SQL queries via pg pool following existing database service conventions.
 *  - Restricts access strictly to the owner using `user_id = $N`.
 *  - Handles sender deletions, throwing descriptive errors if foreign key restrains deletion.
 */

import { db } from '../db/postgres';
import { SenderRow } from '../types/db.types';

export interface CreateSenderInput {
  name: string;
  email: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string;
  smtp_pass: string;
}

export interface UpdateSenderInput {
  name?: string;
  email?: string;
  smtp_host?: string;
  smtp_port?: number;
  smtp_secure?: boolean;
  smtp_user?: string;
  smtp_pass?: string;
}

/**
 * Creates a new sender record.
 */
export async function createSender(
  userId: string,
  input: CreateSenderInput
): Promise<SenderRow> {
  const { rows } = await db.query<SenderRow>(
    `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      userId,
      input.name,
      input.email,
      input.smtp_host,
      input.smtp_port,
      input.smtp_secure,
      input.smtp_user,
      input.smtp_pass,
    ]
  );
  return rows[0]!;
}

/**
 * Lists all senders for the authenticated user.
 */
export async function listSendersByUser(userId: string): Promise<SenderRow[]> {
  const { rows } = await db.query<SenderRow>(
    `SELECT * FROM senders WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

/**
 * Gets a sender by ID and verifies user ownership.
 */
export async function getSenderById(
  id: string,
  userId: string
): Promise<SenderRow | null> {
  const { rows } = await db.query<SenderRow>(
    `SELECT * FROM senders WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows[0] ?? null;
}

/**
 * Gets a sender by ID without ownership checks (for internal worker use).
 */
export async function getSenderByIdInternal(
  id: string
): Promise<SenderRow | null> {
  const { rows } = await db.query<SenderRow>(
    `SELECT * FROM senders WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Updates a sender (ownership enforced, dynamic safe SQL).
 */
export async function updateSender(
  id: string,
  userId: string,
  updates: UpdateSenderInput
): Promise<SenderRow | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.name !== undefined) {
    setClauses.push(`name = $${idx++}`);
    values.push(updates.name);
  }
  if (updates.email !== undefined) {
    setClauses.push(`email = $${idx++}`);
    values.push(updates.email);
  }
  if (updates.smtp_host !== undefined) {
    setClauses.push(`smtp_host = $${idx++}`);
    values.push(updates.smtp_host);
  }
  if (updates.smtp_port !== undefined) {
    setClauses.push(`smtp_port = $${idx++}`);
    values.push(updates.smtp_port);
  }
  if (updates.smtp_secure !== undefined) {
    setClauses.push(`smtp_secure = $${idx++}`);
    values.push(updates.smtp_secure);
  }
  if (updates.smtp_user !== undefined) {
    setClauses.push(`smtp_user = $${idx++}`);
    values.push(updates.smtp_user);
  }
  if (updates.smtp_pass !== undefined) {
    setClauses.push(`smtp_pass = $${idx++}`);
    values.push(updates.smtp_pass);
  }

  if (setClauses.length === 0) {
    return null;
  }

  setClauses.push(`updated_at = NOW()`);

  values.push(id);      // $idx
  values.push(userId);  // $idx+1

  const sql = `
    UPDATE senders
    SET ${setClauses.join(', ')}
    WHERE id = $${idx++} AND user_id = $${idx}
    RETURNING *
  `;

  const { rows } = await db.query<SenderRow>(sql, values);
  return rows[0] ?? null;
}

/**
 * Deletes a sender (ownership enforced).
 * Throws error if Postgres RESTRICT foreign key constraint stops deletion.
 */
export async function deleteSenderForUser(
  id: string,
  userId: string
): Promise<boolean> {
  // First, verify ownership and existence
  const sender = await getSenderById(id, userId);
  if (!sender) {
    return false;
  }

  try {
    const { rowCount } = await db.query(
      `DELETE FROM senders WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return (rowCount ?? 0) > 0;
  } catch (err: any) {
    // 23503 is foreign_key_violation in PostgreSQL
    if (err.code === '23503') {
      throw new Error(
        'Cannot delete sender because it is actively referenced by one or more campaigns.'
      );
    }
    throw err;
  }
}
