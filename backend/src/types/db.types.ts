/**
 * Database row types – one interface per table.
 * These match the column names returned by `pg` (snake_case).
 * Keep in sync with 001_initial_schema.sql.
 */

// ─── users ────────────────────────────────────────────────────────────────────
export interface UserRow {
  id: string;
  google_id: string | null;
  email: string;
  name: string | null;
  created_at: Date;
  updated_at: Date;
}

// ─── campaigns ────────────────────────────────────────────────────────────────
export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed';

export interface CampaignRow {
  id: string;
  user_id: string;
  sender_id: string | null;
  subject: string;
  body: string;
  scheduled_at: Date | null;
  hourly_limit: number;
  status: CampaignStatus;
  created_at: Date;
  updated_at: Date;
}

// ─── recipients ───────────────────────────────────────────────────────────────
export type RecipientStatus = 'pending' | 'sent' | 'failed' | 'bounced';

export interface RecipientRow {
  id: string;
  campaign_id: string;
  email: string;
  name: string | null;
  status: RecipientStatus;
  created_at: Date;
}

// ─── email_logs ───────────────────────────────────────────────────────────────
export type EmailLogStatus = 'sent' | 'failed' | 'bounced';

export interface EmailLogRow {
  id: string;
  campaign_id: string;
  recipient_id: string;
  sender_id: string | null;
  status: EmailLogStatus;
  sent_at: Date | null;
  error_message: string | null;
  created_at: Date;
}

// ─── senders ──────────────────────────────────────────────────────────────────
export interface SenderRow {
  id: string;
  user_id: string;
  name: string;
  email: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string;
  smtp_pass: string;
  created_at: Date;
  updated_at: Date;
}

// ─── slack_integrations ───────────────────────────────────────────────────────
export interface SlackIntegrationRow {
  id: string;
  user_id: string;
  team_id: string;
  team_name: string;
  access_token: string;
  channel_id: string | null;
  channel_name: string | null;
  webhook_url: string | null;
  scope: string;
  created_at: Date;
  updated_at: Date;
}

