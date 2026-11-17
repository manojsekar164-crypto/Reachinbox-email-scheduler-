/**
 * src/types/operationsIntelligence.types.ts
 *
 * Types for the ReachInbox Operations Intelligence Data Service.
 * Provides the foundational data contracts for operational monitoring,
 * failure analysis, sender metrics, queue inspection, and future AI Copilot context.
 */

export interface IntelligenceDateFilter {
  fromDate?: Date | string | null;
  toDate?: Date | string | null;
}

export interface CampaignIntelligenceOptions extends IntelligenceDateFilter {
  campaignId?: string;
  limit?: number;
}

export interface CampaignDeliveryStats {
  total_deliveries: number;
  sent_deliveries: number;
  failed_deliveries: number;
  pending_deliveries: number;
  retry_wait_deliveries: number;
  unknown_deliveries: number;
  scheduled_deliveries: number;
  cancelled_deliveries: number;
  success_rate: number | null; // sent / (sent + failed), null if 0 completed
  failure_rate: number | null; // failed / (sent + failed), null if 0 completed
}

export interface HighFailureCampaign {
  campaign_id: string;
  subject: string;
  status: string;
  sent_count: number;
  failed_count: number;
  unknown_count: number;
  total_deliveries: number;
  failure_rate: number;
}

export interface CampaignIntelligenceResult {
  total_campaigns: number;
  campaigns_by_status: {
    draft: number;
    scheduled: number;
    sending: number;
    paused: number;
    completed: number;
    cancelled: number;
  };
  delivery_stats: CampaignDeliveryStats;
  high_failure_campaigns: HighFailureCampaign[];
}

export interface DeliveryFailureIntelligenceResult {
  total_failed_deliveries: number;
  total_unknown_deliveries: number;
  total_attempts: number;
  error_classifications: Record<string, number>;
  transient_vs_permanent: {
    transient_count: number;
    permanent_count: number;
    uncertain_count: number;
  };
  top_failure_reasons: Array<{
    reason: string;
    count: number;
    sample_delivery_ids: string[];
  }>;
  attempt_distribution: {
    single_attempt: number;
    two_to_three_attempts: number;
    four_or_more_attempts: number;
    max_attempts_observed: number;
  };
  deliveries_approaching_retry_limit: Array<{
    delivery_id: string;
    campaign_id: string;
    recipient_id: string;
    attempt_count: number;
    max_attempts: number;
    last_error: string | null;
    status: string;
  }>;
}

export interface SenderPerformanceMetric {
  sender_id: string;
  name: string;
  email: string;
  hourly_limit: number;
  total_attempts: number;
  unique_deliveries: number;
  confirmed_smtp_acceptances: number;
  confirmed_failures: number;
  unknown_outcomes: number;
  success_rate: number | null;
  failure_rate: number | null;
  health_status: 'healthy' | 'degraded' | 'critical' | 'idle';
  health_reason: string;
}

export interface SenderPerformanceIntelligenceResult {
  senders: SenderPerformanceMetric[];
  aggregate: {
    total_senders: number;
    active_senders: number;
    total_attempts: number;
    total_confirmed_smtp_acceptances: number;
    total_confirmed_failures: number;
    total_unknown_outcomes: number;
    overall_success_rate: number | null;
  };
  metric_notes: {
    success_rate_definition: string;
    attempt_vs_delivery_distinction: string;
    health_indicator_definition: string;
  };
}

export interface QueueJobCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface QueueIntelligenceResult {
  queue_name: string;
  is_available: boolean;
  unavailable_reason?: string | null;
  queue_backlog: number | null;
  global_counts: QueueJobCounts | null;
  user_scoped_counts: QueueJobCounts | null;
}

export type BottleneckSeverity = 'info' | 'warning' | 'critical';

export interface OperationalBottleneck {
  bottleneck_type:
    | 'campaign_hourly_limit_exhausted'
    | 'global_rate_limit_exhausted'
    | 'sender_rate_limit_exhausted'
    | 'send_spacing_restricted'
    | 'excessive_retry_activity'
    | 'large_backlog'
    | 'unknown_deliveries_pending_review';
  severity: BottleneckSeverity;
  observed_fact: string;
  calculated_indicator: string;
  recommendation: string;
  source_ids: string[];
}

export interface OperationalBottleneckAnalysisResult {
  bottlenecks_detected: number;
  bottlenecks: OperationalBottleneck[];
  evaluated_at: string;
}

export interface OperationsContext {
  timestamp: string; // ISO 8601
  user_id: string;
  campaign_summary: {
    total_campaigns: number;
    by_status: Record<string, number>;
    total_deliveries: number;
    deliveries_by_status: Record<string, number>;
    success_rate: number | null;
    failure_rate: number | null;
    high_failure_campaigns: Array<{
      campaign_id: string;
      subject: string;
      sent_count: number;
      failed_count: number;
      unknown_count: number;
      failure_rate: number;
    }>;
  };
  failure_summary: {
    total_failed: number;
    total_unknown: number;
    transient_count: number;
    permanent_count: number;
    top_failure_reasons: Array<{ reason: string; count: number }>;
    error_classifications: Record<string, number>;
    approaching_retry_limit_count: number;
  };
  sender_summary: Array<{
    sender_id: string;
    name: string;
    email: string;
    hourly_limit: number;
    total_attempts: number;
    unique_deliveries: number;
    confirmed_smtp_acceptances: number;
    confirmed_failures: number;
    unknown_outcomes: number;
    success_rate: number | null;
    health_status: 'healthy' | 'degraded' | 'critical' | 'idle';
  }>;
  queue_summary: {
    available: boolean;
    backlog: number | null;
    global_counts: QueueJobCounts | null;
    user_scoped_counts: QueueJobCounts | null;
    notes?: string;
  };
  bottlenecks: Array<{
    type: string;
    severity: BottleneckSeverity;
    fact: string;
    indicator: string;
    recommendation: string;
    source_ids: string[];
  }>;
  recommended_investigations: string[];
  metric_definitions: Record<string, string>;
}
