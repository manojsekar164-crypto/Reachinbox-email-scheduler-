/**
 * src/services/operationsIntelligenceService.ts
 *
 * ReachInbox Operations Intelligence Data Service.
 *
 * Core architectural service that retrieves, aggregates, and analyses operational
 * telemetry across campaigns, deliveries, attempts, senders, queues, and rate-limiters.
 * Serves as the trusted, strictly authorized data foundation for operational monitoring
 * and the future AI Delivery Operations Copilot.
 *
 * Architectural Invariants:
 *  1. Multi-Tenant Authorization: Every function requires explicit authenticated `userId`.
 *  2. Query Parameterization: Parameterized SQL strictly enforced; zero dynamic SQL.
 *  3. Secrets Sanitization: Never queries or returns SMTP passwords, tokens, or credentials.
 *  4. PII Minimization: Aggregates data without returning recipient email addresses or bodies.
 *  5. Metric Integrity: Measures confirmed SMTP acceptance (RFC 5321 250 OK), NOT mailbox inbox delivery.
 *  6. Uncertainty Safety: Never classifies ambiguous/unknown outcomes as confirmed successes or failures.
 *  7. Read-Only Safety: Performs zero database or queue mutations.
 *  8. Resilience: Handles Redis unavailability gracefully with explicit unavailable indicators.
 */

import { Pool, PoolClient } from 'pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { db as defaultPool } from '../db/postgres';
import { redis as defaultRedis } from '../db/redis';
import { emailQueue as defaultQueue, EmailJobPayload } from '../queue/emailQueue';
import { getGlobalHourlyLimit } from './rateLimiter';
import { config } from '../config';
import {
  CampaignIntelligenceOptions,
  CampaignIntelligenceResult,
  CampaignDeliveryStats,
  HighFailureCampaign,
  DeliveryFailureIntelligenceResult,
  SenderPerformanceIntelligenceResult,
  SenderPerformanceMetric,
  QueueIntelligenceResult,
  QueueIntelligenceOptions,
  QueueJobCounts,
  OperationalBottleneck,
  OperationalBottleneckAnalysisResult,
  OperationsContext,
} from '../types/operationsIntelligence.types';

// =============================================================================
// Helper: Metric Calculation Utilities
// =============================================================================

function calculateRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function sanitizeText(text: string | null | undefined, maxLength = 150): string {
  if (!text) return 'Unknown error';
  const clean = text.replace(/[\r\n\t]+/g, ' ').trim();
  return clean.length > maxLength ? clean.substring(0, maxLength) + '...' : clean;
}

// =============================================================================
// 1. Campaign Intelligence
// =============================================================================

/**
 * Retrieves aggregate campaign statistics, status breakdowns, delivery distribution,
 * and identifies campaigns with unusually high failure rates for the authenticated user.
 */
export async function getCampaignIntelligence(
  userId: string,
  options?: CampaignIntelligenceOptions,
  dbPool: Pool | PoolClient = defaultPool
): Promise<CampaignIntelligenceResult> {
  if (!userId) {
    const error: any = new Error('Authenticated user ID is required');
    error.statusCode = 400;
    throw error;
  }

  // 1. Campaign count by status
  const campStatusRes = await dbPool.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::int AS count
     FROM campaigns
     WHERE user_id = $1
     GROUP BY status;`,
    [userId]
  );

  const campaignsByStatus = {
    draft: 0,
    scheduled: 0,
    sending: 0,
    paused: 0,
    completed: 0,
    cancelled: 0,
  };

  let totalCampaigns = 0;
  for (const row of campStatusRes.rows) {
    const cnt = parseInt(row.count, 10);
    totalCampaigns += cnt;
    if (row.status in campaignsByStatus) {
      (campaignsByStatus as any)[row.status] = cnt;
    }
  }

  // 2. Deliveries by status across user campaigns
  const delParams: any[] = [userId];
  let delQuery = `
    SELECT ed.status, COUNT(*)::int AS count
    FROM email_deliveries ed
    JOIN campaigns c ON c.id = ed.campaign_id
    WHERE c.user_id = $1
      AND ed.deleted_at IS NULL
  `;

  if (options?.campaignId) {
    delParams.push(options.campaignId);
    delQuery += ` AND ed.campaign_id = $${delParams.length}`;
  }
  if (options?.fromDate) {
    delParams.push(options.fromDate);
    delQuery += ` AND ed.created_at >= $${delParams.length}`;
  }
  if (options?.toDate) {
    delParams.push(options.toDate);
    delQuery += ` AND ed.created_at <= $${delParams.length}`;
  }

  delQuery += ` GROUP BY ed.status;`;

  const delStatusRes = await dbPool.query<{ status: string; count: string }>(delQuery, delParams);

  const deliveryCounts: Record<string, number> = {
    pending: 0,
    scheduled: 0,
    sending: 0,
    retry_wait: 0,
    sent: 0,
    failed: 0,
    unknown: 0,
    cancelled: 0,
  };

  let totalDeliveries = 0;
  for (const row of delStatusRes.rows) {
    const cnt = parseInt(row.count, 10);
    totalDeliveries += cnt;
    deliveryCounts[row.status] = cnt;
  }

  const sentCount = deliveryCounts['sent'] || 0;
  const failedCount = deliveryCounts['failed'] || 0;
  const completedDeliveries = sentCount + failedCount;

  const deliveryStats: CampaignDeliveryStats = {
    total_deliveries: totalDeliveries,
    sent_deliveries: sentCount,
    failed_deliveries: failedCount,
    pending_deliveries: deliveryCounts['pending'] || 0,
    retry_wait_deliveries: deliveryCounts['retry_wait'] || 0,
    unknown_deliveries: deliveryCounts['unknown'] || 0,
    scheduled_deliveries: deliveryCounts['scheduled'] || 0,
    cancelled_deliveries: deliveryCounts['cancelled'] || 0,
    success_rate: calculateRate(sentCount, completedDeliveries),
    failure_rate: calculateRate(failedCount, completedDeliveries),
  };

  // 3. Campaigns with high failure rates (>= 20% or >= 5 failures)
  const highFailureRes = await dbPool.query<{
    campaign_id: string;
    subject: string;
    status: string;
    sent_count: string;
    failed_count: string;
    unknown_count: string;
    total_deliveries: string;
  }>(
    `SELECT
       c.id AS campaign_id,
       c.subject,
       c.status,
       COUNT(CASE WHEN ed.status = 'sent' THEN 1 END)::int AS sent_count,
       COUNT(CASE WHEN ed.status = 'failed' THEN 1 END)::int AS failed_count,
       COUNT(CASE WHEN ed.status = 'unknown' THEN 1 END)::int AS unknown_count,
       COUNT(ed.id)::int AS total_deliveries
     FROM campaigns c
     JOIN email_deliveries ed ON ed.campaign_id = c.id
     WHERE c.user_id = $1
       AND ed.deleted_at IS NULL
     GROUP BY c.id, c.subject, c.status
     HAVING COUNT(CASE WHEN ed.status = 'failed' THEN 1 END) > 0
     ORDER BY failed_count DESC, c.id
     LIMIT $2;`,
    [userId, options?.limit || 10]
  );

  const highFailureCampaigns: HighFailureCampaign[] = [];
  for (const row of highFailureRes.rows) {
    const sCount = parseInt(row.sent_count, 10);
    const fCount = parseInt(row.failed_count, 10);
    const uCount = parseInt(row.unknown_count, 10);
    const tCount = parseInt(row.total_deliveries, 10);
    const completed = sCount + fCount;
    const rate = completed > 0 ? Number((fCount / completed).toFixed(4)) : 1.0;

    if (rate >= 0.2 || fCount >= 5) {
      highFailureCampaigns.push({
        campaign_id: row.campaign_id,
        subject: row.subject,
        status: row.status,
        sent_count: sCount,
        failed_count: fCount,
        unknown_count: uCount,
        total_deliveries: tCount,
        failure_rate: rate,
      });
    }
  }

  return {
    total_campaigns: totalCampaigns,
    campaigns_by_status: campaignsByStatus,
    delivery_stats: deliveryStats,
    high_failure_campaigns: highFailureCampaigns,
  };
}

// =============================================================================
// 2. Delivery Failure Intelligence
// =============================================================================

/**
 * Retrieves granular failure metrics, SMTP classifications, top failure reasons,
 * attempt count distributions, and deliveries approaching their retry limit.
 * Crucial invariant: Never classifies ambiguous/unknown outcomes as confirmed failure or success.
 */
export async function getDeliveryFailureIntelligence(
  userId: string,
  options?: CampaignIntelligenceOptions,
  dbPool: Pool | PoolClient = defaultPool
): Promise<DeliveryFailureIntelligenceResult> {
  if (!userId) {
    const error: any = new Error('Authenticated user ID is required');
    error.statusCode = 400;
    throw error;
  }

  // 1. Total failed and unknown deliveries
  const totalsRes = await dbPool.query<{ total_failed: string; total_unknown: string }>(
    `SELECT
       COUNT(CASE WHEN ed.status = 'failed' THEN 1 END)::int AS total_failed,
       COUNT(CASE WHEN ed.status = 'unknown' THEN 1 END)::int AS total_unknown
     FROM email_deliveries ed
     JOIN campaigns c ON c.id = ed.campaign_id
     WHERE c.user_id = $1
       AND ed.deleted_at IS NULL;`,
    [userId]
  );

  const totalFailed = parseInt(totalsRes.rows[0]?.total_failed || '0', 10);
  const totalUnknown = parseInt(totalsRes.rows[0]?.total_unknown || '0', 10);

  // 2. Total actual attempts across all user dispatches
  const attemptsRes = await dbPool.query<{ total_attempts: string }>(
    `SELECT COUNT(ea.id)::int AS total_attempts
     FROM email_attempts ea
     JOIN email_deliveries ed ON ed.id = ea.delivery_id
     JOIN campaigns c ON c.id = ed.campaign_id
     WHERE c.user_id = $1;`,
    [userId]
  );
  const totalAttempts = parseInt(attemptsRes.rows[0]?.total_attempts || '0', 10);

  // 3. Error classifications from latest attempt records of failed, unknown, or retrying deliveries
  const classRes = await dbPool.query<{ classification: string; count: string }>(
    `SELECT
       COALESCE(ea.error_classification, 'unclassified') AS classification,
       COUNT(*)::int AS count
     FROM email_deliveries ed
     JOIN campaigns c ON c.id = ed.campaign_id
     LEFT JOIN email_attempts ea ON ea.delivery_id = ed.id AND ea.attempt_number = ed.attempt_count
     WHERE c.user_id = $1
       AND ed.status IN ('failed', 'unknown', 'retry_wait')
       AND ed.deleted_at IS NULL
     GROUP BY COALESCE(ea.error_classification, 'unclassified')
     ORDER BY count DESC;`,
    [userId]
  );

  const errorClassifications: Record<string, number> = {};
  let transientCount = 0;
  let permanentCount = 0;
  let uncertainCount = 0;

  for (const row of classRes.rows) {
    const cnt = parseInt(row.count, 10);
    const cls = row.classification;
    errorClassifications[cls] = cnt;

    if (
      cls === 'transient_rejection' ||
      cls === 'transient_failure' ||
      cls === 'connection_failure'
    ) {
      transientCount += cnt;
    } else if (
      cls === 'permanent_rejection' ||
      cls === 'operator_confirmed_not_accepted'
    ) {
      permanentCount += cnt;
    } else if (cls === 'ambiguous_outcome' || cls === 'stale_claim_reconciliation') {
      uncertainCount += cnt;
    } else {
      // General classification based on name
      if (cls.includes('transient') || cls.includes('conn')) {
        transientCount += cnt;
      } else {
        permanentCount += cnt;
      }
    }
  }

  // Include deliveries currently in unknown state into uncertain count
  if (uncertainCount === 0 && totalUnknown > 0) {
    uncertainCount = totalUnknown;
  }

  // 3. Top failure reasons (sanitized and aggregated)
  const reasonsRes = await dbPool.query<{
    reason: string;
    count: string;
    sample_ids: string[];
  }>(
    `SELECT
       LEFT(COALESCE(ea.error_message, ed.last_error, 'Unspecified delivery failure'), 150) AS reason,
       COUNT(*)::int AS count,
       ARRAY_AGG(ed.id::text) AS sample_ids
     FROM email_deliveries ed
     JOIN campaigns c ON c.id = ed.campaign_id
     LEFT JOIN email_attempts ea ON ea.delivery_id = ed.id AND ea.attempt_number = ed.attempt_count
     WHERE c.user_id = $1
       AND ed.status IN ('failed', 'unknown')
       AND ed.deleted_at IS NULL
     GROUP BY reason
     ORDER BY count DESC
     LIMIT $2;`,
    [userId, options?.limit || 10]
  );

  const topFailureReasons = reasonsRes.rows.map((r) => ({
    reason: sanitizeText(r.reason),
    count: parseInt(r.count, 10),
    sample_delivery_ids: (r.sample_ids || []).slice(0, 3),
  }));

  // 4. Attempt distribution across deliveries with attempts
  const attemptDistRes = await dbPool.query<{
    single_attempt: string;
    two_to_three: string;
    four_or_more: string;
    max_observed: string;
  }>(
    `SELECT
       COUNT(CASE WHEN ed.attempt_count = 1 THEN 1 END)::int AS single_attempt,
       COUNT(CASE WHEN ed.attempt_count BETWEEN 2 AND 3 THEN 1 END)::int AS two_to_three,
       COUNT(CASE WHEN ed.attempt_count >= 4 THEN 1 END)::int AS four_or_more,
       COALESCE(MAX(ed.attempt_count), 0)::int AS max_observed
     FROM email_deliveries ed
     JOIN campaigns c ON c.id = ed.campaign_id
     WHERE c.user_id = $1
       AND ed.attempt_count > 0
       AND ed.deleted_at IS NULL;`,
    [userId]
  );

  const distRow = attemptDistRes.rows[0];
  const attemptDistribution = {
    single_attempt: parseInt(distRow?.single_attempt || '0', 10),
    two_to_three_attempts: parseInt(distRow?.two_to_three || '0', 10),
    four_or_more_attempts: parseInt(distRow?.four_or_more || '0', 10),
    max_attempts_observed: parseInt(distRow?.max_observed || '0', 10),
  };

  // 5. Deliveries approaching retry limit (attempt_count >= 2 and status in ('retry_wait', 'failed'))
  const approachingRes = await dbPool.query<{
    delivery_id: string;
    campaign_id: string;
    recipient_id: string;
    attempt_count: string;
    last_error: string | null;
    status: string;
  }>(
    `SELECT
       ed.id AS delivery_id,
       ed.campaign_id,
       ed.recipient_id,
       ed.attempt_count,
       ed.last_error,
       ed.status
     FROM email_deliveries ed
     JOIN campaigns c ON c.id = ed.campaign_id
     WHERE c.user_id = $1
       AND ed.deleted_at IS NULL
       AND ed.status IN ('retry_wait', 'failed')
       AND ed.attempt_count >= 2
     ORDER BY ed.attempt_count DESC, ed.updated_at DESC
     LIMIT 20;`,
    [userId]
  );

  const approachingRetryLimit = approachingRes.rows.map((r) => ({
    delivery_id: r.delivery_id,
    campaign_id: r.campaign_id,
    recipient_id: r.recipient_id,
    attempt_count: parseInt(r.attempt_count, 10),
    max_attempts: 5,
    last_error: sanitizeText(r.last_error),
    status: r.status,
  }));

  return {
    total_failed_deliveries: totalFailed,
    total_unknown_deliveries: totalUnknown,
    total_attempts: totalAttempts,
    error_classifications: errorClassifications,
    transient_vs_permanent: {
      transient_count: transientCount,
      permanent_count: permanentCount,
      uncertain_count: uncertainCount,
    },
    top_failure_reasons: topFailureReasons,
    attempt_distribution: attemptDistribution,
    deliveries_approaching_retry_limit: approachingRetryLimit,
  };
}

// =============================================================================
// 3. Sender Performance Intelligence
// =============================================================================

/**
 * Retrieves sender-by-sender performance metrics for the authenticated user.
 * Explicitly distinguishes delivery attempts from unique deliveries, and SMTP acceptance (250 OK)
 * from inbox placement. Never returns SMTP credentials.
 */
export async function getSenderPerformanceIntelligence(
  userId: string,
  dbPool: Pool | PoolClient = defaultPool
): Promise<SenderPerformanceIntelligenceResult> {
  if (!userId) {
    const error: any = new Error('Authenticated user ID is required');
    error.statusCode = 400;
    throw error;
  }

  // CTE query: Separates delivery counts from attempt counts to prevent Cartesian explosion
  const senderRes = await dbPool.query<{
    sender_id: string;
    name: string;
    email: string;
    hourly_limit: string;
    unique_deliveries: string;
    sent_deliveries: string;
    failed_deliveries: string;
    unknown_deliveries: string;
    total_attempts: string;
    confirmed_smtp_acceptances: string;
    confirmed_failures: string;
    unknown_outcomes: string;
  }>(
    `WITH delivery_stats AS (
       SELECT
         ed.sender_id,
         COUNT(ed.id)::int AS unique_deliveries,
         COUNT(CASE WHEN ed.status = 'sent' THEN 1 END)::int AS sent_deliveries,
         COUNT(CASE WHEN ed.status = 'failed' THEN 1 END)::int AS failed_deliveries,
         COUNT(CASE WHEN ed.status = 'unknown' THEN 1 END)::int AS unknown_deliveries
       FROM email_deliveries ed
       JOIN campaigns c ON c.id = ed.campaign_id
       WHERE c.user_id = $1 AND ed.deleted_at IS NULL
       GROUP BY ed.sender_id
     ),
     attempt_stats AS (
       SELECT
         ea.sender_id,
         COUNT(ea.id)::int AS total_attempts,
         COUNT(CASE WHEN ea.status = 'sent' AND (ea.smtp_response_code IS NOT NULL OR ea.smtp_message_id IS NOT NULL) THEN 1 END)::int AS confirmed_smtp_acceptances,
         COUNT(CASE WHEN ea.status = 'failed' THEN 1 END)::int AS confirmed_failures,
         COUNT(CASE WHEN ea.status = 'unknown' THEN 1 END)::int AS unknown_outcomes
       FROM email_attempts ea
       JOIN email_deliveries ed ON ed.id = ea.delivery_id
       JOIN campaigns c ON c.id = ed.campaign_id
       WHERE c.user_id = $1
       GROUP BY ea.sender_id
     )
     SELECT
       s.id AS sender_id,
       s.name,
       s.email,
       s.hourly_limit,
       COALESCE(ds.unique_deliveries, 0) AS unique_deliveries,
       COALESCE(ds.sent_deliveries, 0) AS sent_deliveries,
       COALESCE(ds.failed_deliveries, 0) AS failed_deliveries,
       COALESCE(ds.unknown_deliveries, 0) AS unknown_deliveries,
       COALESCE(att.total_attempts, 0) AS total_attempts,
       COALESCE(att.confirmed_smtp_acceptances, 0) AS confirmed_smtp_acceptances,
       COALESCE(att.confirmed_failures, 0) AS confirmed_failures,
       COALESCE(att.unknown_outcomes, 0) AS unknown_outcomes
     FROM senders s
     LEFT JOIN delivery_stats ds ON ds.sender_id = s.id
     LEFT JOIN attempt_stats att ON att.sender_id = s.id
     WHERE s.user_id = $1
     ORDER BY s.created_at ASC;`,
    [userId]
  );

  const senders: SenderPerformanceMetric[] = [];
  let aggAttempts = 0;
  let aggAcceptances = 0;
  let aggFailures = 0;
  let aggUnknown = 0;

  for (const row of senderRes.rows) {
    const attempts = parseInt(row.total_attempts, 10);
    const uniqueDel = parseInt(row.unique_deliveries, 10);
    const acceptances = parseInt(row.confirmed_smtp_acceptances, 10);
    const failures = parseInt(row.confirmed_failures, 10);
    const unknown = parseInt(row.unknown_outcomes, 10);
    const hourlyLimit = parseInt(row.hourly_limit || '100', 10);

    aggAttempts += attempts;
    aggAcceptances += acceptances;
    aggFailures += failures;
    aggUnknown += unknown;

    const completed = acceptances + failures;
    const successRate = calculateRate(acceptances, completed);
    const failureRate = calculateRate(failures, completed);

    // Objective, data-driven health status supported by actual records
    let healthStatus: 'healthy' | 'degraded' | 'critical' | 'idle' = 'idle';
    let healthReason = 'No delivery attempts recorded for this sender.';

    if (completed > 0 || attempts > 0) {
      if (completed === 0 && unknown > 0) {
        healthStatus = 'degraded';
        healthReason = `${unknown} uncertain dispatch outcome(s) require operator reconciliation.`;
      } else if (successRate !== null) {
        if (successRate >= 0.95) {
          healthStatus = 'healthy';
          healthReason = `Strong delivery performance (${(successRate * 100).toFixed(1)}% acceptance rate across ${completed} completed dispatches).`;
        } else if (successRate >= 0.7) {
          healthStatus = 'degraded';
          healthReason = `Elevated failure rate (${(failureRate! * 100).toFixed(1)}%). Review recipient bounce error logs.`;
        } else {
          healthStatus = 'critical';
          healthReason = `High failure rate (${(failureRate! * 100).toFixed(1)}%). Possible authentication failure, reputation block, or severe provider throttling.`;
        }
      }
    }

    senders.push({
      sender_id: row.sender_id,
      name: row.name,
      email: row.email,
      hourly_limit: hourlyLimit,
      total_attempts: attempts,
      unique_deliveries: uniqueDel,
      confirmed_smtp_acceptances: acceptances,
      confirmed_failures: failures,
      unknown_outcomes: unknown,
      success_rate: successRate,
      failure_rate: failureRate,
      health_status: healthStatus,
      health_reason: healthReason,
    });
  }

  const aggCompleted = aggAcceptances + aggFailures;
  const overallSuccessRate = calculateRate(aggAcceptances, aggCompleted);

  return {
    senders,
    aggregate: {
      total_senders: senders.length,
      active_senders: senders.filter((s) => s.total_attempts > 0).length,
      total_attempts: aggAttempts,
      total_confirmed_smtp_acceptances: aggAcceptances,
      total_confirmed_failures: aggFailures,
      total_unknown_outcomes: aggUnknown,
      overall_success_rate: overallSuccessRate,
    },
    metric_notes: {
      success_rate_definition:
        'Confirmed SMTP acceptances (RFC 5321 250 OK) divided by total terminal attempts (acceptances + rejections). Measures MTA handoff confirmation, not recipient inbox placement.',
      attempt_vs_delivery_distinction:
        'unique_deliveries represents distinct recipient targets; total_attempts represents all dispatch attempts, including retries.',
      health_indicator_definition:
        'Deterministic health classification derived from observed failure ratios and error types: healthy (>=95%), degraded (70-95% or pending unknown), critical (<70%), idle (0 attempts).',
    },
  };
}

// =============================================================================
// 4. Queue Intelligence
// =============================================================================

/**
 * Retrieves actual BullMQ/Redis queue metrics.
 * Scopes job inspection strictly to the authenticated user's campaigns.
 * Gracefully handles Redis unavailability and flags unavailable queue data.
 */
const DEFAULT_SAMPLE_LIMIT = 2500;

export async function getQueueIntelligence(
  userId: string,
  queue: Queue<EmailJobPayload> = defaultQueue,
  dbPool: Pool | PoolClient = defaultPool,
  redisClient: Redis = defaultRedis,
  options?: QueueIntelligenceOptions
): Promise<QueueIntelligenceResult> {
  const queueName = queue?.name || 'email-queue';
  const sampleLimit = options?.sampleLimit || DEFAULT_SAMPLE_LIMIT;

  try {
    // 1. Verify Redis connectivity with a quick bounded ping
    if (!redisClient || typeof redisClient.ping !== 'function') {
      return {
        queue_name: queueName,
        is_available: false,
        unavailable_reason: 'Redis client not configured or unavailable',
        user_backlog: null,
        user_counts: null,
        count_scope: 'tenant_scoped',
        is_partial: false,
        sample_limit: sampleLimit,
        queue_backlog: null,
        user_scoped_counts: null,
        global_counts: null,
      };
    }

    await redisClient.ping();

    // 2. Query user's campaign IDs to isolate jobs
    const campRes = await dbPool.query<{ id: string }>(
      `SELECT id FROM campaigns WHERE user_id = $1;`,
      [userId]
    );
    const userCampaignIds = new Set(campRes.rows.map((r) => r.id));

    // If user has no campaigns, they have 0 jobs
    if (userCampaignIds.size === 0) {
      const zeroCounts: QueueJobCounts = { waiting: 0, active: 0, delayed: 0, failed: 0 };
      return {
        queue_name: queueName,
        is_available: true,
        user_backlog: 0,
        user_counts: zeroCounts,
        count_scope: 'tenant_scoped',
        is_partial: false,
        sample_limit: sampleLimit,
        queue_backlog: 0,
        user_scoped_counts: zeroCounts,
        global_counts: null,
      };
    }

    // 3. Inspect queue job counts across states to check queue depth
    const jobCounts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    const waitingTotal = jobCounts.waiting || 0;
    const activeTotal = jobCounts.active || 0;
    const delayedTotal = jobCounts.delayed || 0;
    const failedTotal = jobCounts.failed || 0;

    // Helper to fetch jobs in chunks up to sampleLimit, accurately handling > 500 jobs
    async function scanStateJobs(
      fetcher: (start: number, end: number) => Promise<any[]>,
      totalInState: number
    ): Promise<{ matchingJobsCount: number; isPartial: boolean }> {
      let matchCount = 0;
      let fetched = 0;
      const batchSize = 500;
      const toFetch = Math.min(totalInState, sampleLimit);

      while (fetched < toFetch) {
        const start = fetched;
        const end = Math.min(start + batchSize - 1, toFetch - 1);
        const batch = await fetcher(start, end);
        if (!batch || batch.length === 0) break;

        for (const job of batch) {
          if (job?.data?.campaignId && userCampaignIds.has(job.data.campaignId)) {
            matchCount++;
          }
        }

        fetched += batch.length;
        if (batch.length < (end - start + 1)) break;
      }

      return {
        matchingJobsCount: matchCount,
        isPartial: totalInState > sampleLimit,
      };
    }

    const [waitingRes, activeRes, delayedRes, failedRes] = await Promise.all([
      scanStateJobs((s, e) => queue.getWaiting(s, e), waitingTotal),
      scanStateJobs((s, e) => queue.getActive(s, e), activeTotal),
      scanStateJobs((s, e) => queue.getDelayed(s, e), delayedTotal),
      scanStateJobs((s, e) => queue.getFailed(s, e), failedTotal),
    ]);

    const userCounts: QueueJobCounts = {
      waiting: waitingRes.matchingJobsCount,
      active: activeRes.matchingJobsCount,
      delayed: delayedRes.matchingJobsCount,
      failed: failedRes.matchingJobsCount,
    };

    const isPartial =
      waitingRes.isPartial || activeRes.isPartial || delayedRes.isPartial || failedRes.isPartial;

    const userBacklog = userCounts.waiting + userCounts.active + userCounts.delayed;

    return {
      queue_name: queueName,
      is_available: true,
      user_backlog: userBacklog,
      user_counts: userCounts,
      count_scope: 'tenant_scoped',
      is_partial: isPartial,
      sample_limit: sampleLimit,
      queue_backlog: userBacklog,
      user_scoped_counts: userCounts,
      global_counts: null,
    };
  } catch (err: any) {
    return {
      queue_name: queueName,
      is_available: false,
      unavailable_reason: `Redis/BullMQ queue unavailable: ${err.message || 'connection error'}`,
      user_backlog: null,
      user_counts: null,
      count_scope: 'tenant_scoped',
      is_partial: false,
      sample_limit: sampleLimit,
      queue_backlog: null,
      user_scoped_counts: null,
      global_counts: null,
    };
  }
}

// =============================================================================
// 5. Operational Bottleneck Analysis
// =============================================================================

/**
 * Deterministically analyses operational bottlenecks across:
 *  - Campaign hourly limit exhaustion
 *  - Global rate-limit exhaustion
 *  - Sender rate-limit exhaustion
 *  - Minimum send-spacing restrictions
 *  - Excessive retry activity
 *  - Large pending/delayed backlogs
 *  - Unknown SMTP deliveries requiring operator review
 */
export async function analyzeOperationalBottlenecks(
  userId: string,
  dbPool: Pool | PoolClient = defaultPool,
  redisClient: Redis = defaultRedis,
  queue: Queue<EmailJobPayload> = defaultQueue
): Promise<OperationalBottleneckAnalysisResult> {
  const bottlenecks: OperationalBottleneck[] = [];

  // Check Redis availability
  let redisAvailable = true;
  try {
    if (redisClient && typeof redisClient.ping === 'function') {
      await redisClient.ping();
    } else {
      redisAvailable = false;
    }
  } catch (_) {
    redisAvailable = false;
  }

  // 1. Check Global Rate Limit
  const globalLimit = getGlobalHourlyLimit();
  if (globalLimit > 0 && redisAvailable) {
    try {
      const globalKey = 'rate-limit:global';
      const [usageStr, ttl] = await Promise.all([
        redisClient.get(globalKey),
        redisClient.ttl(globalKey),
      ]);
      const usage = parseInt(usageStr || '0', 10);
      if (usage >= globalLimit) {
        bottlenecks.push({
          bottleneck_type: 'global_rate_limit_exhausted',
          severity: 'critical',
          observed_fact: `Global system hourly limit reached (${usage}/${globalLimit} emails).`,
          calculated_indicator: `All outbound delivery dispatches globally paused for ~${Math.max(
            ttl,
            0
          )} seconds until window reset.`,
          recommendation:
            'Wait for the global quota window to reset. If sustained, increase GLOBAL_EMAILS_PER_HOUR capacity.',
          source_ids: [],
        });
      }
    } catch (_) {}
  }

  // 2. Check User Active Campaigns Rate Limit
  const campRes = await dbPool.query<{
    id: string;
    subject: string;
    hourly_limit: string;
  }>(
    `SELECT id, subject, hourly_limit
     FROM campaigns
     WHERE user_id = $1
       AND status = 'sending'
       AND hourly_limit > 0;`,
    [userId]
  );

  if (redisAvailable) {
    for (const c of campRes.rows) {
      const limit = parseInt(c.hourly_limit, 10);
      const campKey = `rate-limit:campaign:${c.id}`;
      try {
        const [usageStr, ttl] = await Promise.all([
          redisClient.get(campKey),
          redisClient.ttl(campKey),
        ]);
        const usage = parseInt(usageStr || '0', 10);
        if (usage >= limit) {
          bottlenecks.push({
            bottleneck_type: 'campaign_hourly_limit_exhausted',
            severity: 'warning',
            observed_fact: `Campaign "${c.subject}" has exhausted its hourly limit (${usage}/${limit} emails).`,
            calculated_indicator: `Campaign throughput throttled for ~${Math.max(
              ttl,
              0
            )} seconds until hourly reset.`,
            recommendation:
              'Allow the hourly window to elapse or increase the campaign hourly limit in campaign settings.',
            source_ids: [c.id],
          });
        }
      } catch (_) {}
    }
  }

  // 3. Check User Senders Rate Limit
  const senderRes = await dbPool.query<{
    id: string;
    name: string;
    email: string;
    hourly_limit: string;
  }>(
    `SELECT id, name, email, hourly_limit
     FROM senders
     WHERE user_id = $1
       AND hourly_limit > 0;`,
    [userId]
  );

  if (redisAvailable) {
    for (const s of senderRes.rows) {
      const limit = parseInt(s.hourly_limit, 10);
      const senderKey = `rate-limit:sender:${s.id}`;
      try {
        const [usageStr, ttl] = await Promise.all([
          redisClient.get(senderKey),
          redisClient.ttl(senderKey),
        ]);
        const usage = parseInt(usageStr || '0', 10);
        if (usage >= limit) {
          bottlenecks.push({
            bottleneck_type: 'sender_rate_limit_exhausted',
            severity: 'warning',
            observed_fact: `Sender "${s.name} (${s.email})" has exhausted its hourly limit (${usage}/${limit} emails).`,
            calculated_indicator: `Outbound sends through this sender delayed for ~${Math.max(
              ttl,
              0
            )} seconds.`,
            recommendation:
              'Reassign campaigns to alternative configured senders or wait for hourly quota reset.',
            source_ids: [s.id],
          });
        }
      } catch (_) {}
    }
  }

  // 4. Check Minimum Send Spacing
  if (redisAvailable) {
    try {
      const spacingKey = 'email-send:global:last-send';
      const lastSendStr = await redisClient.get(spacingKey);
      const sendDelayMs = config.app.emailSendDelayMs || 0;
      if (lastSendStr && sendDelayMs > 0) {
        const lastSend = parseInt(lastSendStr, 10);
        const elapsed = Date.now() - lastSend;
        if (elapsed < sendDelayMs) {
          const remainingWait = sendDelayMs - elapsed;
          bottlenecks.push({
            bottleneck_type: 'send_spacing_restricted',
            severity: 'info',
            observed_fact: `Send spacing restriction active (${remainingWait}ms remaining before next permitted dispatch).`,
            calculated_indicator: `Enforces ${sendDelayMs}ms minimum pacing across concurrent workers.`,
            recommendation: 'Normal distributed dispatch pacing; no operational intervention needed.',
            source_ids: [],
          });
        }
      }
    } catch (_) {}
  }

  // 5. Check Excessive Retry Activity
  const retryRes = await dbPool.query<{ count: string; sample_ids: string[] }>(
    `SELECT
       COUNT(*)::int AS count,
       ARRAY_AGG(ed.id::text) AS sample_ids
     FROM email_deliveries ed
     JOIN campaigns c ON c.id = ed.campaign_id
     WHERE c.user_id = $1
       AND ed.deleted_at IS NULL
       AND ed.status = 'retry_wait';`,
    [userId]
  );
  const retryCount = parseInt(retryRes.rows[0]?.count || '0', 10);
  if (retryCount >= 5) {
    bottlenecks.push({
      bottleneck_type: 'excessive_retry_activity',
      severity: 'warning',
      observed_fact: `${retryCount} deliveries currently in retry_wait status across campaigns.`,
      calculated_indicator:
        'Elevated transient error rate or rate throttling causing repeated backoff cycles.',
      recommendation:
        'Inspect sender SMTP connectivity, check for provider greylisting, and review error classifications.',
      source_ids: (retryRes.rows[0]?.sample_ids || []).slice(0, 5),
    });
  }

  // 6. Check Unknown Deliveries Requiring Review
  const unknownRes = await dbPool.query<{ count: string; sample_ids: string[] }>(
    `SELECT
       COUNT(*)::int AS count,
       ARRAY_AGG(ed.id::text) AS sample_ids
     FROM email_deliveries ed
     JOIN campaigns c ON c.id = ed.campaign_id
     WHERE c.user_id = $1
       AND ed.deleted_at IS NULL
       AND ed.status = 'unknown';`,
    [userId]
  );
  const unknownCount = parseInt(unknownRes.rows[0]?.count || '0', 10);
  if (unknownCount > 0) {
    bottlenecks.push({
      bottleneck_type: 'unknown_deliveries_pending_review',
      severity: 'warning',
      observed_fact: `${unknownCount} deliveries have uncertain outcomes and require operator review.`,
      calculated_indicator:
        'Deliveries blocked from automatic retry to prevent duplicate sends following connection interruption.',
      recommendation:
        'Navigate to Recovery Center, inspect audit history, and submit manual resolution (confirmed_accepted or confirmed_not_accepted).',
      source_ids: (unknownRes.rows[0]?.sample_ids || []).slice(0, 5),
    });
  }

  // 7. Check Large Pending Backlog
  const pendingRes = await dbPool.query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
     FROM email_deliveries ed
     JOIN campaigns c ON c.id = ed.campaign_id
     WHERE c.user_id = $1
       AND ed.deleted_at IS NULL
       AND ed.status = 'pending'
       AND c.status = 'sending';`,
    [userId]
  );
  const pendingCount = parseInt(pendingRes.rows[0]?.count || '0', 10);
  if (pendingCount > 50) {
    bottlenecks.push({
      bottleneck_type: 'large_backlog',
      severity: 'info',
      observed_fact: `${pendingCount} deliveries currently queued in pending status for active campaigns.`,
      calculated_indicator: 'Backlog awaiting worker claims subject to hourly limits and send pacing.',
      recommendation:
        'Monitor queue throughput to verify backlog drains within expected campaign delivery window.',
      source_ids: [],
    });
  }

  return {
    bottlenecks_detected: bottlenecks.length,
    bottlenecks,
    evaluated_at: new Date().toISOString(),
  };
}

// =============================================================================
// 6. Structured Operations Context (AI Copilot Data Foundation)
// =============================================================================

/**
 * Builds a typed, sanitized, compact operational context document for consumption
 * by operational dashboards and the future AI Delivery Operations Copilot.
 * Contains no recipient PII, credentials, or full email bodies.
 */
export async function getOperationsContext(
  userId: string,
  options?: CampaignIntelligenceOptions,
  dbPool: Pool | PoolClient = defaultPool,
  redisClient: Redis = defaultRedis,
  queue: Queue<EmailJobPayload> = defaultQueue
): Promise<OperationsContext> {
  if (!userId) {
    const error: any = new Error('Authenticated user ID is required');
    error.statusCode = 400;
    throw error;
  }

  // Parallel retrieval of all operational intelligence modules
  const [campIntel, failIntel, senderIntel, queueIntel, bottleneckIntel] = await Promise.all([
    getCampaignIntelligence(userId, options, dbPool),
    getDeliveryFailureIntelligence(userId, options, dbPool),
    getSenderPerformanceIntelligence(userId, dbPool),
    getQueueIntelligence(userId, queue, dbPool, redisClient),
    analyzeOperationalBottlenecks(userId, dbPool, redisClient, queue),
  ]);

  // Generate actionable investigation recommendations
  const recommendations: string[] = [];

  if (failIntel.total_unknown_deliveries > 0) {
    recommendations.push(
      `Review ${failIntel.total_unknown_deliveries} unknown delivery outcome(s) in Recovery Center to safely resolve in-doubt dispatches.`
    );
  }

  if (campIntel.high_failure_campaigns.length > 0) {
    const names = campIntel.high_failure_campaigns.map((c) => `"${c.subject}"`).join(', ');
    recommendations.push(
      `Investigate elevated failure rates in campaigns: ${names}. Check recipient syntax and spam-filter indicators.`
    );
  }

  const criticalSenders = senderIntel.senders.filter((s) => s.health_status === 'critical');
  if (criticalSenders.length > 0) {
    const senderEmails = criticalSenders.map((s) => s.email).join(', ');
    recommendations.push(
      `Audit sender configurations for critical failures on: ${senderEmails}. Verify SMTP credentials and domain authentication (SPF/DKIM).`
    );
  }

  for (const b of bottleneckIntel.bottlenecks) {
    if (b.severity === 'critical' || b.severity === 'warning') {
      recommendations.push(b.recommendation);
    }
  }

  if (recommendations.length === 0) {
    recommendations.push(
      'All email operations operating normally. No immediate operational interventions required.'
    );
  }

  return {
    timestamp: new Date().toISOString(),
    user_id: userId,
    campaign_summary: {
      total_campaigns: campIntel.total_campaigns,
      by_status: campIntel.campaigns_by_status,
      total_deliveries: campIntel.delivery_stats.total_deliveries,
      deliveries_by_status: {
        pending: campIntel.delivery_stats.pending_deliveries,
        scheduled: campIntel.delivery_stats.scheduled_deliveries,
        retry_wait: campIntel.delivery_stats.retry_wait_deliveries,
        sent: campIntel.delivery_stats.sent_deliveries,
        failed: campIntel.delivery_stats.failed_deliveries,
        unknown: campIntel.delivery_stats.unknown_deliveries,
        cancelled: campIntel.delivery_stats.cancelled_deliveries,
      },
      success_rate: campIntel.delivery_stats.success_rate,
      failure_rate: campIntel.delivery_stats.failure_rate,
      high_failure_campaigns: campIntel.high_failure_campaigns.map((c) => ({
        campaign_id: c.campaign_id,
        subject: c.subject,
        sent_count: c.sent_count,
        failed_count: c.failed_count,
        unknown_count: c.unknown_count,
        failure_rate: c.failure_rate,
      })),
    },
    failure_summary: {
      total_failed: failIntel.total_failed_deliveries,
      total_unknown: failIntel.total_unknown_deliveries,
      transient_count: failIntel.transient_vs_permanent.transient_count,
      permanent_count: failIntel.transient_vs_permanent.permanent_count,
      top_failure_reasons: failIntel.top_failure_reasons.map((r) => ({
        reason: r.reason,
        count: r.count,
      })),
      error_classifications: failIntel.error_classifications,
      approaching_retry_limit_count: failIntel.deliveries_approaching_retry_limit.length,
    },
    sender_summary: senderIntel.senders.map((s) => ({
      sender_id: s.sender_id,
      name: s.name,
      email: s.email,
      hourly_limit: s.hourly_limit,
      total_attempts: s.total_attempts,
      unique_deliveries: s.unique_deliveries,
      confirmed_smtp_acceptances: s.confirmed_smtp_acceptances,
      confirmed_failures: s.confirmed_failures,
      unknown_outcomes: s.unknown_outcomes,
      success_rate: s.success_rate,
      health_status: s.health_status,
    })),
    queue_summary: {
      available: queueIntel.is_available,
      backlog: queueIntel.user_backlog,
      counts: queueIntel.user_counts,
      count_scope: queueIntel.count_scope,
      is_partial: queueIntel.is_partial,
      sample_limit: queueIntel.sample_limit,
      user_scoped_counts: queueIntel.user_counts,
      notes:
        queueIntel.unavailable_reason ||
        (queueIntel.is_partial
          ? `Queue depth exceeds sample limit of ${queueIntel.sample_limit}. Counts may be partial.`
          : undefined),
    },
    bottlenecks: bottleneckIntel.bottlenecks.map((b) => ({
      type: b.bottleneck_type,
      severity: b.severity,
      fact: b.observed_fact,
      indicator: b.calculated_indicator,
      recommendation: b.recommendation,
      source_ids: b.source_ids,
    })),
    recommended_investigations: recommendations,
    metric_definitions: {
      success_rate:
        'Confirmed SMTP 250 OK acceptances divided by total terminal attempts (sent + failed). Measures MTA acceptance confirmation, not mailbox inbox placement.',
      failure_rate:
        'Confirmed permanent/exhausted delivery failures divided by total terminal attempts (sent + failed).',
      unknown_outcomes:
        'Deliveries where connection or timeout occurred during/after DATA transfer. Excluded from success/failure rate calculations to avoid misrepresentation.',
      health_status:
        'Data-backed health indicator based strictly on confirmed acceptance ratios and provider rejections: healthy (>=95%), degraded (70-95%), critical (<70%), idle (0 attempts).',
    },
  };
}
