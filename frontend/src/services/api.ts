import { apiClient, API_BASE_URL } from '../api/client';
import type {
  User,
  Campaign,
  Sender,
  Recipient,
  SearchResponse,
  SlackStatus,
  CreateCampaignPayload,
  AllSendersHealthSummary,
  SenderHealthMetrics,
  SenderProbeResult,
  PreflightRequest,
  PreflightResponse,
  DeliveriesResponse,
  DeliveryAttempt,
  CopilotChatContext,
  CopilotResponse,
} from '../types';

export const authApi = {
  getMe: () => apiClient<{ authenticated: boolean; user: User | null }>('/auth/me'),
  logout: () => apiClient<{ message: string }>('/auth/logout', { method: 'POST' }),
  getGoogleLoginUrl: () => `${API_BASE_URL}/auth/google`,
};

export const campaignApi = {
  list: (params?: { status?: string }) => apiClient<Campaign[]>('/campaigns', { params }),
  get: (id: string) => apiClient<Campaign>(`/campaigns/${id}`),
  create: (data: CreateCampaignPayload) =>
    apiClient<{ campaign: Campaign; recipients: Recipient[] }>('/campaigns', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getRecipients: (campaignId: string) =>
    apiClient<{ recipients: Recipient[] }>(`/campaigns/${campaignId}/recipients`),
  getDeliveries: (campaignId: string, params?: { status?: string; page?: number; limit?: number }) =>
    apiClient<DeliveriesResponse>(`/campaigns/${campaignId}/deliveries`, { params }),
  delete: (id: string) => apiClient<{ message: string }>(`/campaigns/${id}`, { method: 'DELETE' }),
  pause: (id: string) =>
    apiClient<{ campaign: Campaign; message: string }>(`/campaigns/${id}/pause`, { method: 'POST' }),
  resume: (id: string) =>
    apiClient<{ campaign: Campaign; message: string }>(`/campaigns/${id}/resume`, { method: 'POST' }),
  cancel: (id: string) =>
    apiClient<{ campaign: Campaign; message: string; cancelled_deliveries_count: number; in_flight_count: number }>(
      `/campaigns/${id}/cancel`,
      { method: 'POST' }
    ),
};

export const senderApi = {
  list: () => apiClient<Sender[]>('/senders'),
  get: (id: string) => apiClient<Sender>(`/senders/${id}`),
  getHealth: () => apiClient<AllSendersHealthSummary>('/senders/health'),
  getSenderHealth: (id: string) => apiClient<SenderHealthMetrics>(`/senders/${id}/health`),
  probe: (id: string) => apiClient<SenderProbeResult>(`/senders/${id}/probe`, { method: 'POST' }),
  create: (data: {
    name: string;
    email: string;
    smtp_host: string;
    smtp_port: number;
    smtp_secure: boolean;
    smtp_user: string;
    smtp_pass: string;
    hourly_limit?: number;
  }) =>
    apiClient<Sender>('/senders', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (
    id: string,
    data: {
      name?: string;
      email?: string;
      smtp_host?: string;
      smtp_port?: number;
      smtp_secure?: boolean;
      smtp_user?: string;
      smtp_pass?: string;
      hourly_limit?: number;
    }
  ) =>
    apiClient<Sender>(`/senders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: string) => apiClient<{ message: string }>(`/senders/${id}`, { method: 'DELETE' }),
};

export const deliveryApi = {
  list: (params?: {
    status?: string;
    campaign_id?: string;
    error_classification?: string;
    page?: number;
    limit?: number;
  }) => apiClient<DeliveriesResponse>('/deliveries', { params }),
  listFailed: (params?: { page?: number; limit?: number }) =>
    apiClient<DeliveriesResponse>('/deliveries/failed', { params }),
  listUnknown: (params?: { page?: number; limit?: number }) =>
    apiClient<DeliveriesResponse>('/deliveries/unknown', { params }),
  getAttempts: (id: string) =>
    apiClient<{ attempts: DeliveryAttempt[] }>(`/deliveries/${id}/attempts`),
  retry: (id: string) =>
    apiClient<{ success: boolean; message: string; delivery_id: string }>(`/deliveries/${id}/retry`, {
      method: 'POST',
    }),
  resolve: (id: string, resolution: 'confirmed_delivered' | 'confirmed_failed', notes?: string) =>
    apiClient<{ success: boolean; message: string; resolution: string }>(`/deliveries/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolution, notes }),
    }),
};

export const preflightApi = {
  run: (data: PreflightRequest) =>
    apiClient<PreflightResponse>('/preflight', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  forCampaign: (campaignId: string) =>
    apiClient<PreflightResponse>(`/campaigns/${campaignId}/preflight`, {
      method: 'POST',
    }),
};

export const copilotApi = {
  chat: (question: string, context?: CopilotChatContext) =>
    apiClient<CopilotResponse>('/copilot/chat', {
      method: 'POST',
      body: JSON.stringify({ question, context }),
    }),
};

export const emailApi = {
  search: (params: { q?: string; status?: string; page?: number; limit?: number }) =>
    apiClient<SearchResponse>('/emails/search', { params }),
};

export const slackApi = {
  getStatus: () => apiClient<SlackStatus>('/auth/slack/status'),
  disconnect: () => apiClient<{ message: string }>('/auth/slack', { method: 'DELETE' }),
  getConnectUrl: () => `${API_BASE_URL}/auth/slack`,
};
