export interface User {
  id: string;
  email: string;
  name: string;
}

export interface AuthState {
  authenticated: boolean;
  user: User | null;
  loading: boolean;
}

export interface Sender {
  id: string;
  user_id: string;
  name: string;
  email: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string;
  created_at: string;
  updated_at: string;
}

export interface Recipient {
  id: string;
  campaign_id: string;
  email: string;
  name?: string;
  status?: string;
  created_at?: string;
}

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'completed' | 'paused' | 'cancelled';

export interface Campaign {
  id: string;
  user_id: string;
  sender_id: string | null;
  subject: string;
  body: string;
  status: CampaignStatus;
  scheduled_at: string | null;
  hourly_limit: number;
  created_at: string;
  updated_at: string;
  recipients?: Recipient[];
  recipient_count?: number;
  recipients_count?: number;
}

export interface EmailLog {
  id: string;
  campaign_id: string;
  recipient_id: string;
  sender_id: string | null;
  status: 'pending' | 'sent' | 'failed';
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
  recipient_email?: string;
  recipient_name?: string;
  subject?: string;
}

export interface SearchResultItem {
  id: string;
  campaignId: string;
  recipientId: string;
  userId: string;
  recipientEmail: string;
  recipientName: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt?: string;
  sentAt?: string;
  updatedAt?: string;
}

export interface SearchResponse {
  query: string;
  count: number;
  results: SearchResultItem[];
}

export interface SlackStatus {
  connected: boolean;
  teamName?: string;
  channelName?: string;
}

export interface CreateCampaignPayload {
  subject: string;
  body: string;
  scheduled_at?: string | null;
  sender_id: string;
  hourly_limit: number;
  recipients: { email: string; name?: string }[];
}

export type SenderHealthStatus = 'healthy' | 'degraded' | 'quarantined';

export interface SenderHealthMetrics {
  sender_id: string;
  name: string;
  email: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  hourly_limit: number;
  hourly_usage: number;
  quota_remaining: number;
  unique_deliveries: number;
  total_attempts: number;
  sent_deliveries: number;
  failed_deliveries: number;
  unknown_deliveries: number;
  acceptance_rate: number;
  bounce_rate: number;
  transient_failure_rate: number;
  reputation_score: number;
  health_status: SenderHealthStatus;
  health_reasons: string[];
  last_attempt_at: string | null;
}

export interface SenderProbeResult {
  sender_id: string;
  email: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  reachable: boolean;
  authenticated: boolean;
  latency_ms: number;
  tls_active: boolean;
  response_message: string;
  error_code?: string;
  error_message?: string;
  probed_at: string;
}

export interface AllSendersHealthSummary {
  total_senders: number;
  healthy_count: number;
  degraded_count: number;
  quarantined_count: number;
  overall_reputation_score: number;
  senders: SenderHealthMetrics[];
}


export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title?: string;
  message: string;
}

// ─── Smart Campaign Preflight Types ──────────────────────────────────────────
export interface ImportDiagnostics {
  total_rows: number;
  valid_count: number;
  invalid_count: number;
  duplicate_count: number;
  invalid: { row: number; email: string; reason: string }[];
  duplicates: { row: number; email: string; reason: string }[];
}

export interface PreflightRequest {
  sender_id?: string;
  campaign_id?: string;
  hourly_limit?: number;
  scheduled_at?: string | null;
  recipients?: { email: string; name?: string }[];
  csv_content?: string;
  import_diagnostics?: ImportDiagnostics;
}

export interface PreflightResponse {
  success: boolean;
  validation: {
    counts: {
      total_rows: number;
      valid_count: number;
      invalid_count: number;
      duplicate_count: number;
      existing_count: number;
    };
    valid: { row: number; email: string; name?: string }[];
    invalid: { row: number; email: string; reason: string }[];
    duplicates: { row: number; email: string; reason: string }[];
    existing: { row: number; email: string; reason: string }[];
    errors: string[];
  };
  capacity: {
    sender: { hourly_limit: number; current_used: number; remaining_hourly: number };
    campaign: { hourly_limit: number; current_used: number; remaining_hourly: number };
    spacing?: { min_delay_ms: number; max_hourly_rate: number; current_wait_ms: number };
    effective_hourly_rate: number;
    current_hour_remaining: number;
    primary_bottleneck: string;
  };
  forecast: {
    recipient_count: number;
    estimated_start_at: string;
    estimated_completion_at: string;
    estimated_duration_seconds: number;
    is_approximate: boolean;
    confidence: string;
    explanation?: string;
    assumptions: string[];
    warnings: string[];
  };
}

// ─── Delivery Failure & Recovery Center Types ───────────────────────────────
export type DeliveryStatus =
  | 'pending'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'retry_wait'
  | 'unknown'
  | 'cancelled';

export interface EmailDelivery {
  id: string;
  campaign_id: string;
  recipient_id: string;
  sender_id: string;
  status: DeliveryStatus;
  sent_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  recipient_email?: string;
  recipient_name?: string;
  campaign_subject?: string;
  sender_name?: string;
  sender_email?: string;
  attempt_count?: number;
  retry_eligible?: boolean;
  retry_reason?: string;
  retry_eligibility?: {
    is_eligible: boolean;
    reason?: string;
  };
  latest_attempt?: {
    id: string;
    attempt_number: number;
    status: string;
    error_classification?: string | null;
    error_message?: string | null;
    smtp_response_code?: string | null;
    smtp_message_id?: string | null;
    attempted_at: string;
    completed_at?: string | null;
  } | null;
}

export interface DeliveryAttempt {
  id: string;
  delivery_id: string;
  attempt_number: number;
  status: string;
  smtp_response_code: string | null;
  error_classification: string | null;
  error_message: string | null;
  attempted_at: string;
  completed_at: string | null;
}

export interface DeliveriesResponse {
  deliveries: EmailDelivery[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    has_next: boolean;
    has_prev: boolean;
  };
}

// ─── AI Copilot Types ────────────────────────────────────────────────────────
export interface CopilotChatContext {
  date_range?: 'last_24_hours' | 'last_7_days' | 'last_30_days' | 'all_time';
  campaign_id?: string;
}

export interface CopilotSourceReference {
  type: 'campaign' | 'delivery' | 'sender' | 'queue' | 'bottleneck';
  id?: string;
  label?: string;
}

export interface CopilotResponse {
  success: boolean;
  answer: string;
  insights: string[];
  recommendations: string[];
  sources: CopilotSourceReference[];
  generated_at: string;
  data_freshness: {
    retrieved_at: string;
    is_partial: boolean;
  };
}
