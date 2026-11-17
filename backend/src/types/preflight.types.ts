/**
 * src/types/preflight.types.ts
 *
 * TypeScript types and interfaces for Smart Campaign Preflight & Delivery Forecast.
 */

export interface ValidRecipientRow {
  row: number;
  email: string;
  name?: string;
}

export interface InvalidRecipientRow {
  row: number;
  email: string;
  reason: string;
  raw?: string;
}

export interface DuplicateRecipientRow {
  row: number;
  email: string;
  reason: string;
  raw?: string;
}

export interface ExistingRecipientRow {
  row: number;
  email: string;
  reason: string;
  raw?: string;
}

export interface ValidationCounts {
  total_rows: number;
  valid_count: number;
  invalid_count: number;
  duplicate_count: number;
  existing_count: number;
}

export interface RecipientValidationResult {
  counts: ValidationCounts;
  valid: ValidRecipientRow[];
  invalid: InvalidRecipientRow[];
  duplicates: DuplicateRecipientRow[];
  existing: ExistingRecipientRow[];
  errors: string[];
}

export interface SenderCapacityInfo {
  id: string;
  email: string;
  hourly_limit: number;
  current_used: number;
  remaining_hourly: number;
  window_ttl_seconds: number;
}

export interface CampaignCapacityInfo {
  hourly_limit: number;
  current_used: number;
  remaining_hourly: number;
  window_ttl_seconds: number;
}

export interface GlobalCapacityInfo {
  hourly_limit: number;
  current_used: number;
  remaining_hourly: number | null;
  enabled: boolean;
  window_ttl_seconds: number;
}

export interface SpacingCapacityInfo {
  min_delay_ms: number;
  max_hourly_rate: number;
  current_wait_ms: number;
}

export interface QueuedWorkInfo {
  active_or_waiting_jobs: number;
}

export type BottleneckReason =
  | 'campaign_hourly_limit'
  | 'sender_hourly_limit'
  | 'global_hourly_limit'
  | 'minimum_spacing';

export interface PreflightCapacityResult {
  sender: SenderCapacityInfo;
  campaign: CampaignCapacityInfo;
  global: GlobalCapacityInfo;
  spacing: SpacingCapacityInfo;
  queued_work: QueuedWorkInfo;
  effective_hourly_rate: number;
  current_hour_remaining: number;
  primary_bottleneck: BottleneckReason;
}

export interface DeliveryForecastResult {
  recipient_count: number;
  estimated_start_at: string;
  estimated_completion_at: string;
  estimated_duration_seconds: number;
  is_approximate: boolean;
  confidence: 'approximate' | 'exact';
  assumptions: string[];
  warnings: string[];
}

export interface WhatIfScenarioResult {
  simulated_hourly_limit: number;
  simulated_campaign_remaining: number;
  simulated_current_hour_remaining: number;
  effective_hourly_rate: number;
  primary_bottleneck: BottleneckReason;
  estimated_duration_seconds: number;
  estimated_completion_at: string;
}

export interface PreflightResult {
  success: boolean;
  validation: RecipientValidationResult;
  capacity: PreflightCapacityResult;
  forecast: DeliveryForecastResult;
  what_if_scenario?: WhatIfScenarioResult | null;
}

export interface RecipientInputItem {
  email?: string;
  name?: string;
}

export interface RunPreflightInput {
  userId: string;
  senderId?: string;
  campaignId?: string;
  hourlyLimit?: number;
  scheduledAt?: string | Date | null;
  content?: string;
  recipients?: RecipientInputItem[];
  recipientCount?: number;
  maxUploadSizeBytes?: number;
}
