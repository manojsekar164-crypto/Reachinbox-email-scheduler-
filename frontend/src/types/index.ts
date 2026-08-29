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

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'completed' | 'paused';

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

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title?: string;
  message: string;
}
