import { apiClient, API_BASE_URL } from '../api/client';
import type {
  User,
  Campaign,
  Sender,
  Recipient,
  SearchResponse,
  SlackStatus,
  CreateCampaignPayload,
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
  delete: (id: string) => apiClient<{ message: string }>(`/campaigns/${id}`, { method: 'DELETE' }),
};

export const senderApi = {
  list: () => apiClient<Sender[]>('/senders'),
  get: (id: string) => apiClient<Sender>(`/senders/${id}`),
  create: (data: {
    name: string;
    email: string;
    smtp_host: string;
    smtp_port: number;
    smtp_secure: boolean;
    smtp_user: string;
    smtp_pass: string;
  }) =>
    apiClient<Sender>('/senders', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  delete: (id: string) => apiClient<{ message: string }>(`/senders/${id}`, { method: 'DELETE' }),
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
