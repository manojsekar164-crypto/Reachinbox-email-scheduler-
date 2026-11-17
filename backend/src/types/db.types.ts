/**
 * Database row types – one interface per table.
 * These match the column names returned by `pg` (snake_case).
 * Synchronized with all migrations (001 - 005).
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
export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'completed' | 'sent' | 'failed';

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
  hourly_limit: number;
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

// ─── email_deliveries (Stage 1 Durable Delivery Model) ─────────────────────────
export type DeliveryStatus =
  | 'pending'
  | 'scheduled'
  | 'sending'
  | 'retry_wait'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'cancelled';

export interface EmailDeliveryRow {
  id: string;
  campaign_id: string;
  recipient_id: string;
  sender_id: string | null;
  idempotency_key: string;
  status: DeliveryStatus;
  scheduled_at: Date | null;
  sent_at: Date | null;
  smtp_message_id: string | null;
  attempt_count: number;
  last_error: string | null;
  next_attempt_at: Date | null;
  claim_owner: string | null;
  claimed_at: Date | null;
  lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ─── email_attempts (Stage 1 Attempt History) ──────────────────────────────────
export type EmailAttemptStatus =
  | 'attempting'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'rate_limited';

export interface EmailAttemptRow {
  id: string;
  delivery_id: string;
  attempt_number: number;
  status: EmailAttemptStatus;
  smtp_response_code: string | null;
  smtp_message_id: string | null;
  error_classification: string | null;
  error_message: string | null;
  attempted_at: Date;
  completed_at: Date | null;
}

// ─── delivery_outbox (Stage 1 Transactional Outbox Schema) ─────────────────────
export type OutboxStatus = 'pending' | 'processing' | 'dispatched' | 'failed';

export interface DeliveryOutboxRow {
  id: string;
  event_type: string;
  aggregate_id: string;
  deduplication_key: string;
  payload: Record<string, any>;
  status: OutboxStatus;
  attempt_count: number;
  available_at: Date;
  created_at: Date;
  dispatched_at: Date | null;
  last_error: string | null;
}

// ─── schema_migrations (Stage 1 Migration Version Tracking) ───────────────────
export interface SchemaMigrationRow {
  filename: string;
  checksum: string;
  applied_at: Date;
}
