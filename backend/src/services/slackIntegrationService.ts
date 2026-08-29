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

/**
 * Saves or updates (upserts) the Slack integration for a specific user.
 * Tokens and webhook URLs are encrypted at rest.
 */
export async function saveSlackIntegration(
  input: SaveSlackIntegrationInput,
): Promise<SlackIntegrationRow> {
  const encryptedAccessToken = encrypt(input.accessToken);
  const encryptedWebhookUrl = input.webhookUrl ? encrypt(input.webhookUrl) : null;

  const { rows } = await db.query<SlackIntegrationRow>(
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
): Promise<SlackIntegrationRow | null> {
  const { rows } = await db.query<SlackIntegrationRow>(
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
): Promise<boolean> {
  const { rowCount } = await db.query(
    'DELETE FROM slack_integrations WHERE user_id = $1',
    [userId],
  );
  return (rowCount ?? 0) > 0;
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
