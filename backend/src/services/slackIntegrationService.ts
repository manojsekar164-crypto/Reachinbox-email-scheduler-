import { Pool, PoolClient } from 'pg';
import { db } from '../db/postgres';
import { SlackIntegrationRow } from '../types/db.types';
import { encrypt, decrypt } from '../utils/crypto';

export interface SaveSlackIntegrationInput {
  userId: string;
  teamId: string;
  teamName: string;
  accessToken: string;
  channelId: string | null;
  channelName: string | null;
  webhookUrl: string | null;
  scope: string;
}

export interface PublicSlackStatus {
  connected: boolean;
  teamId?: string;
  teamName?: string;
  channelId?: string | null;
  channelName?: string | null;
  scope?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Saves or updates (upserts) the Slack integration for a specific user.
 * Tokens and webhook URLs are encrypted at rest using AES-256-GCM.
 */
export async function saveSlackIntegration(
  input: SaveSlackIntegrationInput,
  poolClient: Pool | PoolClient = db,
): Promise<SlackIntegrationRow> {
  const encryptedAccessToken = encrypt(input.accessToken);
  const encryptedWebhookUrl = input.webhookUrl ? encrypt(input.webhookUrl) : null;

  const { rows } = await poolClient.query<SlackIntegrationRow>(
    `INSERT INTO slack_integrations (
      user_id, team_id, team_name, access_token, channel_id, channel_name, webhook_url, scope, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
      team_id = EXCLUDED.team_id,
      team_name = EXCLUDED.team_name,
      access_token = EXCLUDED.access_token,
      channel_id = EXCLUDED.channel_id,
      channel_name = EXCLUDED.channel_name,
      webhook_url = EXCLUDED.webhook_url,
      scope = EXCLUDED.scope,
      updated_at = NOW()
    RETURNING *`,
    [
      input.userId,
      input.teamId,
      input.teamName,
      encryptedAccessToken,
      input.channelId,
      input.channelName,
      encryptedWebhookUrl,
      input.scope,
    ],
  );

  return decryptSlackIntegrationRow(rows[0]);
}

/**
 * Retrieves the Slack integration details for a user.
 * Decrypts tokens and webhook URLs before returning them.
 */
export async function getSlackIntegrationByUserId(
  userId: string,
  poolClient: Pool | PoolClient = db,
): Promise<SlackIntegrationRow | null> {
  const { rows } = await poolClient.query<SlackIntegrationRow>(
    'SELECT * FROM slack_integrations WHERE user_id = $1 LIMIT 1',
    [userId],
  );
  if (!rows[0]) {
    return null;
  }
  return decryptSlackIntegrationRow(rows[0]);
}

/**
 * Removes the Slack integration for a user.
 */
export async function deleteSlackIntegrationByUserId(
  userId: string,
  poolClient: Pool | PoolClient = db,
): Promise<boolean> {
  const { rowCount } = await poolClient.query(
    'DELETE FROM slack_integrations WHERE user_id = $1',
    [userId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Formats a safe public representation of the Slack integration status.
 * Guarantees zero exposure of access tokens or webhook secret URLs.
 */
export function toPublicSlackStatus(
  integration: SlackIntegrationRow | null,
): PublicSlackStatus {
  if (!integration) {
    return { connected: false };
  }

  return {
    connected: true,
    teamId: integration.team_id,
    teamName: integration.team_name,
    channelId: integration.channel_id,
    channelName: integration.channel_name,
    scope: integration.scope,
    createdAt: integration.created_at,
    updatedAt: integration.updated_at,
  };
}

/**
 * Internal helper to decrypt encrypted fields of a SlackIntegrationRow.
 */
function decryptSlackIntegrationRow(
  row: SlackIntegrationRow,
): SlackIntegrationRow {
  return {
    ...row,
    access_token: decrypt(row.access_token),
    webhook_url: row.webhook_url ? decrypt(row.webhook_url) : null,
  };
}
