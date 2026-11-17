/**
 * src/types/recovery.types.ts
 *
 * Types for Email Failure & Recovery Center:
 *  - Failure listing, filtering, pagination and sorting
 *  - Delivery details and immutable attempt audit history
 *  - Manual retry authorization and deduplication
 *  - Operator resolution for unknown/ambiguous deliveries
 *  - Campaign lifecycle controls (pause, resume, cancel)
 */

import { DeliveryStatus, EmailAttemptRow, EmailDeliveryRow } from './db.types';

export type ResolutionDecision = 'confirmed_accepted' | 'confirmed_not_accepted';

export interface DeliveryResolutionRow {
  id: string;
  delivery_id: string;
  user_id: string;
  decision: ResolutionDecision;
  reason: string;
  previous_status: string;
  new_status: string;
  metadata?: Record<string, any> | null;
  created_at: Date;
}

export interface RetryEligibilityInfo {
  is_eligible: boolean;
  reason: string;
  max_attempts_reached?: boolean;
}

export interface DeliveryListItem {
  id: string;
  campaign_id: string;
  campaign_subject: string;
  recipient_id: string;
  recipient_email: string;
  recipient_name: string | null;
  sender_id: string | null;
  sender_email: string | null;
  sender_name: string | null;
  status: DeliveryStatus;
  attempt_count: number;
  last_error: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
  latest_attempt: {
    id: string;
    attempt_number: number;
    status: string;
    error_classification: string | null;
    error_message: string | null;
    smtp_response_code: string | null;
    smtp_message_id: string | null;
    attempted_at: string;
    completed_at: string | null;
  } | null;
  retry_eligibility: RetryEligibilityInfo;
}

export interface DeliveryDetailResult extends DeliveryListItem {
  attempts: EmailAttemptRow[];
  resolutions: DeliveryResolutionRow[];
}

export interface ListDeliveriesOptions {
  userId: string;
  status?: DeliveryStatus | DeliveryStatus[];
  campaignId?: string;
  senderId?: string;
  errorClassification?: string;
  fromDate?: Date | string;
  toDate?: Date | string;
  limit?: number;
  offset?: number;
  page?: number;
  sortBy?: 'created_at' | 'updated_at' | 'attempt_count';
  sortOrder?: 'asc' | 'desc';
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  total_pages: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface PaginatedDeliveriesResult {
  deliveries: DeliveryListItem[];
  pagination: PaginationMeta;
}

export interface ManualRetryResult {
  success: boolean;
  delivery_id: string;
  campaign_id: string;
  recipient_id: string;
  status: DeliveryStatus;
  attempt_number: number;
  outbox_event_id: string;
  deduplication_key: string;
  message: string;
}

export interface ResolveUnknownInput {
  decision: ResolutionDecision;
  reason: string;
  metadata?: Record<string, any>;
}

export interface ResolveUnknownResult {
  success: boolean;
  delivery_id: string;
  previous_status: DeliveryStatus;
  new_status: DeliveryStatus;
  decision: ResolutionDecision;
  reason: string;
  resolution_id: string;
  message: string;
  delivery: EmailDeliveryRow;
}

export interface CancelCampaignOptions {
  injectFailure?: boolean;
}

export interface CampaignControlResult {
  success: boolean;
  campaign_id: string;
  previous_status: string;
  status: string;
  message: string;
  in_flight_count?: number;
  republished_count?: number;
  cancelled_count?: number;
}
