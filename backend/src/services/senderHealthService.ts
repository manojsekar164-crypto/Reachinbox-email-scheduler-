/**
 * src/services/senderHealthService.ts
 *
 * Dedicated Sender Health Monitoring and Live Diagnostics Service.
 * Implements Stage 8 (Sender Health Monitor) of the ReachInbox Roadmap (Batch 10).
 *
 * Security & Accuracy Hardening:
 *  1. Quota degradation: Usage >= 90% transitions 'healthy' to 'degraded'; 'quarantined' is strictly preserved.
 *  2. SMTP TLS enforcement: Strict certificate validation (rejectUnauthorized: true), port 465 implicit TLS,
 *     port 587 STARTTLS, and refusal of unencrypted credential transmission.
 *  3. Accurate Redis key: Uses authoritative 'rate-limit:sender:<id>' key matching rateLimiter.ts.
 *  4. Correct metric denominator: Evaluates completed delivery outcomes (sent + failed + unknown).
 *     Pending, scheduled, sending, retry_wait, and cancelled deliveries are excluded from failure calculations.
 *  5. Strict multi-tenant isolation: All queries scoped to authenticated user ID.
 *  6. Credential protection: Passwords are redacted in all logs and probe diagnostics.
 */

import { Pool, PoolClient } from 'pg';
import nodemailer from 'nodemailer';
import { db as defaultPool } from '../db/postgres';
import { redis as defaultRedis } from '../db/redis';
import { safeDecrypt } from '../utils/crypto';
import { SenderRow } from '../types/db.types';

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

/**
 * Calculates a reputation score (0-100) based on completed delivery outcomes.
 */
function calculateReputationScore(
  completedDeliveries: number,
  sentDeliveries: number,
  failedDeliveries: number,
  unknownDeliveries: number,
  bounceDeliveries: number
): { score: number; status: SenderHealthStatus; reasons: string[] } {
  // New or unutilized senders start with a neutral-healthy score of 100
  if (completedDeliveries === 0) {
    return {
      score: 100,
      status: 'healthy',
      reasons: ['No completed dispatch history recorded yet. Default baseline reputation active.'],
    };
  }

  const reasons: string[] = [];
  const acceptanceRate = (sentDeliveries / completedDeliveries) * 100;
  const bounceRate = (bounceDeliveries / completedDeliveries) * 100;
  const unknownRate = (unknownDeliveries / completedDeliveries) * 100;

  let score = 100;

  // Deduct heavily for hard bounces / invalid recipients (1.5x factor)
  score -= bounceRate * 1.5;

  // Deduct moderately for general delivery failures
  const generalFailures = Math.max(0, failedDeliveries - bounceDeliveries);
  score -= (generalFailures / completedDeliveries) * 50;

  // Deduct mildly for ambiguous / unknown outcomes
  score -= unknownRate * 0.5;

  score = Math.max(0, Math.min(100, Math.round(score)));

  let status: SenderHealthStatus = 'healthy';

  if (bounceRate >= 30 || score < 50) {
    status = 'quarantined';
    reasons.push(
      `Critical failure rate: bounce rate is ${bounceRate.toFixed(1)}% (threshold: 30%) and reputation score is ${score}/100. Dispatches should be paused to protect domain reputation.`
    );
  } else if (acceptanceRate < 85 || bounceRate >= 10 || score < 75) {
    status = 'degraded';
    if (bounceRate >= 10) {
      reasons.push(`Elevated bounce rate observed: ${bounceRate.toFixed(1)}% (threshold: 10%).`);
    }
    if (acceptanceRate < 85) {
      reasons.push(`Sub-optimal SMTP acceptance rate: ${acceptanceRate.toFixed(1)}% (expected >= 85%).`);
    }
    if (unknownRate >= 15) {
      reasons.push(`High ambiguous outcome rate: ${unknownRate.toFixed(1)}% timeout or dropped connections.`);
    }
  } else {
    reasons.push(`Optimal performance: ${acceptanceRate.toFixed(1)}% acceptance rate with negligible bounce rate.`);
  }

  return { score, status, reasons };
}

/**
 * Retrieves real-time sender health metrics for a specific sender.
 */
export async function getSenderHealth(
  senderId: string,
  userId: string,
  dbPool: Pool | PoolClient = defaultPool,
  redisClient: any = defaultRedis
): Promise<SenderHealthMetrics> {
  // 1. Verify sender ownership
  const senderRes = await dbPool.query<SenderRow>(
    `SELECT id, user_id, name, email, smtp_host, smtp_port, smtp_secure, hourly_limit, created_at
     FROM senders
     WHERE id = $1 AND user_id = $2;`,
    [senderId, userId]
  );

  if (senderRes.rows.length === 0) {
    const error: any = new Error('Sender not found or access denied');
    error.statusCode = 404;
    throw error;
  }

  const sender = senderRes.rows[0];
  const hourlyLimit = sender.hourly_limit ?? 100;

  // 2. Query delivery statistics for this sender
  // Invariant: Do not count pending, scheduled, sending, retry_wait or cancelled as failures
  const deliveryStatsRes = await dbPool.query<{
    unique_deliveries: string;
    sent_deliveries: string;
    failed_deliveries: string;
    unknown_deliveries: string;
    bounce_deliveries: string;
    last_attempt_at: string | null;
  }>(
    `SELECT
       COUNT(ed.id)::int AS unique_deliveries,
       COUNT(CASE WHEN ed.status = 'sent' THEN 1 END)::int AS sent_deliveries,
       COUNT(CASE WHEN ed.status = 'failed' THEN 1 END)::int AS failed_deliveries,
       COUNT(CASE WHEN ed.status = 'unknown' THEN 1 END)::int AS unknown_deliveries,
       COUNT(CASE WHEN ea.error_classification IN ('mailbox_not_found', 'invalid_recipient', 'policy_rejection') THEN 1 END)::int AS bounce_deliveries,
       MAX(ea.attempted_at) AS last_attempt_at
     FROM email_deliveries ed
     JOIN campaigns c ON c.id = ed.campaign_id
     LEFT JOIN (
       SELECT DISTINCT ON (delivery_id) delivery_id, error_classification, attempted_at
       FROM email_attempts
       ORDER BY delivery_id, attempt_number DESC, attempted_at DESC
     ) ea ON ea.delivery_id = ed.id
     WHERE ed.sender_id = $1
       AND c.user_id = $2
       AND ed.deleted_at IS NULL;`,
    [senderId, userId]
  );

  const stats = deliveryStatsRes.rows[0] || {
    unique_deliveries: '0',
    sent_deliveries: '0',
    failed_deliveries: '0',
    unknown_deliveries: '0',
    bounce_deliveries: '0',
    last_attempt_at: null,
  };

  const uniqueDeliveries = parseInt(stats.unique_deliveries, 10) || 0;
  const sentDeliveries = parseInt(stats.sent_deliveries, 10) || 0;
  const failedDeliveries = parseInt(stats.failed_deliveries, 10) || 0;
  const unknownDeliveries = parseInt(stats.unknown_deliveries, 10) || 0;
  const bounceDeliveries = parseInt(stats.bounce_deliveries, 10) || 0;

  // 3. Query total attempt counts from email_attempts
  const attemptsRes = await dbPool.query<{ count: string }>(
    `SELECT COUNT(ea.id)::int AS count
     FROM email_attempts ea
     JOIN email_deliveries ed ON ed.id = ea.delivery_id
     JOIN campaigns c ON c.id = ed.campaign_id
     WHERE ed.sender_id = $1 AND c.user_id = $2;`,
    [senderId, userId]
  );
  const totalAttempts = parseInt(attemptsRes.rows[0]?.count || '0', 10);

  // 4. Query current hourly usage from Redis using exact key 'rate-limit:sender:<id>'
  let hourlyUsage = 0;
  try {
    if (redisClient && typeof redisClient.get === 'function') {
      const usageStr = await redisClient.get(`rate-limit:sender:${senderId}`);
      hourlyUsage = usageStr ? Math.max(0, parseInt(usageStr, 10) || 0) : 0;
    }
  } catch (_) {
    // If Redis connection fails, fallback to 0 without throwing
    hourlyUsage = 0;
  }
  const quotaRemaining = Math.max(0, hourlyLimit - hourlyUsage);

  // 5. Calculate completed outcomes denominator (sent + failed + unknown)
  const completedDeliveries = sentDeliveries + failedDeliveries + unknownDeliveries;

  const acceptanceRate =
    completedDeliveries > 0 ? parseFloat(((sentDeliveries / completedDeliveries) * 100).toFixed(2)) : 100.0;
  const bounceRate =
    completedDeliveries > 0 ? parseFloat(((bounceDeliveries / completedDeliveries) * 100).toFixed(2)) : 0.0;
  const transientRate =
    completedDeliveries > 0
      ? parseFloat((((failedDeliveries - bounceDeliveries) / completedDeliveries) * 100).toFixed(2))
      : 0.0;

  const { score, status, reasons } = calculateReputationScore(
    completedDeliveries,
    sentDeliveries,
    failedDeliveries,
    unknownDeliveries,
    bounceDeliveries
  );

  let finalStatus = status;

  // 6. Quota-based degradation check (Threshold: >= 90%)
  // Invariant:
  // - Usage below 90% does not trigger quota degradation.
  // - Usage at or above 90% changes 'healthy' to 'degraded'.
  // - A 'quarantined' sender must remain 'quarantined' (quota saturation never overwrites more severe state).
  const quotaRatio = hourlyLimit > 0 ? hourlyUsage / hourlyLimit : 0;
  if (hourlyLimit > 0 && quotaRatio >= 0.9) {
    const quotaPercentage = Math.round(quotaRatio * 100);
    reasons.push(
      `Hourly send quota nearly exhausted: ${hourlyUsage}/${hourlyLimit} sends used (${quotaPercentage}%).`
    );
    if (finalStatus === 'healthy') {
      finalStatus = 'degraded';
    }
  }

  return {
    sender_id: sender.id,
    name: sender.name,
    email: sender.email,
    smtp_host: sender.smtp_host,
    smtp_port: sender.smtp_port,
    smtp_secure: sender.smtp_secure,
    hourly_limit: hourlyLimit,
    hourly_usage: hourlyUsage,
    quota_remaining: quotaRemaining,
    unique_deliveries: uniqueDeliveries,
    total_attempts: totalAttempts,
    sent_deliveries: sentDeliveries,
    failed_deliveries: failedDeliveries,
    unknown_deliveries: unknownDeliveries,
    acceptance_rate: acceptanceRate,
    bounce_rate: bounceRate,
    transient_failure_rate: Math.max(0, transientRate),
    reputation_score: score,
    health_status: finalStatus,
    health_reasons: reasons,
    last_attempt_at: stats.last_attempt_at,
  };
}

/**
 * Retrieves aggregate health metrics for all senders owned by the authenticated user.
 */
export async function listAllSendersHealth(
  userId: string,
  dbPool: Pool | PoolClient = defaultPool,
  redisClient: any = defaultRedis
): Promise<AllSendersHealthSummary> {
  const sendersRes = await dbPool.query<{ id: string }>(
    `SELECT id FROM senders WHERE user_id = $1 ORDER BY created_at DESC;`,
    [userId]
  );

  const metrics: SenderHealthMetrics[] = [];
  for (const row of sendersRes.rows) {
    const m = await getSenderHealth(row.id, userId, dbPool, redisClient);
    metrics.push(m);
  }

  const healthyCount = metrics.filter((m) => m.health_status === 'healthy').length;
  const degradedCount = metrics.filter((m) => m.health_status === 'degraded').length;
  const quarantinedCount = metrics.filter((m) => m.health_status === 'quarantined').length;

  const totalReputation = metrics.reduce((acc, m) => acc + m.reputation_score, 0);
  const overallReputation =
    metrics.length > 0 ? Math.round(totalReputation / metrics.length) : 100;

  return {
    total_senders: metrics.length,
    healthy_count: healthyCount,
    degraded_count: degradedCount,
    quarantined_count: quarantinedCount,
    overall_reputation_score: overallReputation,
    senders: metrics,
  };
}

/**
 * Maps error messages and error codes to standardized diagnostic error classifications.
 */
function classifyProbeError(err: any): { errorCode: string; reachable: boolean } {
  const code = (err.code || '').toUpperCase();
  const msg = (err.message || '').toLowerCase();

  if (
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'ETLS' ||
    msg.includes('certificate') ||
    msg.includes('self-signed') ||
    msg.includes('cert_')
  ) {
    return { errorCode: 'ETLS', reachable: true };
  }

  if (msg.includes('starttls') || msg.includes('greeting never received') || code === 'ESTARTTLS') {
    return { errorCode: 'ESTARTTLS', reachable: true };
  }

  if (code === 'EAUTH' || msg.includes('invalid login') || msg.includes('535') || err.responseCode === 535) {
    return { errorCode: 'EAUTH', reachable: true };
  }

  if (code === 'EDNS' || code === 'ENOTFOUND' || msg.includes('getaddrinfo enotfound')) {
    return { errorCode: 'EDNS', reachable: false };
  }

  if (code === 'ETIMEDOUT' || msg.includes('timedout') || msg.includes('timeout')) {
    return { errorCode: 'ETIMEDOUT', reachable: false };
  }

  if (code === 'ECONNREFUSED' || msg.includes('connection refused')) {
    return { errorCode: 'ECONNREFUSED', reachable: false };
  }

  return { errorCode: code || 'ESOCKET', reachable: false };
}

/**
 * Executes a live SMTP diagnostic probe (handshake, TLS verification, and auth check) for a configured sender.
 * Enforces strict TLS certificate validation. Never exposes plaintext passwords.
 */
export async function probeSenderConnectivity(
  senderId: string,
  userId: string,
  dbPool: Pool | PoolClient = defaultPool,
  transporterOverride?: nodemailer.Transporter
): Promise<SenderProbeResult> {
  // 1. Fetch sender with decrypted credentials using dbPool
  const senderRes = await dbPool.query<SenderRow>(
    `SELECT * FROM senders WHERE id = $1 AND user_id = $2;`,
    [senderId, userId]
  );
  if (senderRes.rows.length === 0) {
    const error: any = new Error('Sender not found or access denied');
    error.statusCode = 404;
    throw error;
  }

  const rawSender = senderRes.rows[0];
  const sender = {
    ...rawSender,
    smtp_pass: safeDecrypt(rawSender.smtp_pass),
    hourly_limit: rawSender.hourly_limit ?? 100,
  };

  const startTime = Date.now();
  const probedAt = new Date().toISOString();
  const port = Number(sender.smtp_port) || 587;

  // Determine TLS mode
  const isImplicitTls = port === 465 || (sender.smtp_secure && port !== 587);
  const isStartTls = port === 587 || (!isImplicitTls && sender.smtp_secure);

  // Insecure configuration guard: Reject transmitting credentials over plaintext
  if (!isImplicitTls && !isStartTls) {
    return {
      sender_id: sender.id,
      email: sender.email,
      smtp_host: sender.smtp_host,
      smtp_port: sender.smtp_port,
      smtp_secure: false,
      reachable: false,
      authenticated: false,
      latency_ms: Date.now() - startTime,
      tls_active: false,
      response_message: 'Insecure SMTP configuration rejected: credentials cannot be transmitted over unencrypted plaintext connection. Enable TLS or STARTTLS.',
      error_code: 'EINSECURE',
      error_message: 'Refusing to authenticate over unencrypted SMTP connection without TLS or STARTTLS.',
      probed_at: probedAt,
    };
  }

  // If a transporter override is supplied (e.g. in unit/mock tests), verify against it
  if (transporterOverride) {
    try {
      await transporterOverride.verify();
      const latencyMs = Date.now() - startTime;
      const tlsActive =
        (transporterOverride as any)._mockTlsActive !== undefined
          ? Boolean((transporterOverride as any)._mockTlsActive)
          : true;

      return {
        sender_id: sender.id,
        email: sender.email,
        smtp_host: sender.smtp_host,
        smtp_port: sender.smtp_port,
        smtp_secure: sender.smtp_secure,
        reachable: true,
        authenticated: true,
        latency_ms: latencyMs,
        tls_active: tlsActive,
        response_message: 'SMTP handshake and authentication verified successfully.',
        probed_at: probedAt,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      const { errorCode, reachable } = classifyProbeError(err);
      const sanitizedMessage = (err.message || 'SMTP probe verification failed').replace(
        sender.smtp_pass,
        '[REDACTED]'
      );

      return {
        sender_id: sender.id,
        email: sender.email,
        smtp_host: sender.smtp_host,
        smtp_port: sender.smtp_port,
        smtp_secure: sender.smtp_secure,
        reachable,
        authenticated: false,
        latency_ms: latencyMs,
        tls_active: false,
        response_message: 'SMTP verification failed.',
        error_code: errorCode,
        error_message: sanitizedMessage,
        probed_at: probedAt,
      };
    }
  }

  // Live SMTP verification with strict TLS validation
  const transporter = nodemailer.createTransport({
    host: sender.smtp_host,
    port,
    secure: isImplicitTls,
    requireTLS: isStartTls,
    auth: {
      user: sender.smtp_user,
      pass: sender.smtp_pass,
    },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000,
    tls: {
      rejectUnauthorized: true, // Strict certificate validation - NEVER accept invalid certs
      minVersion: 'TLSv1.2',
    },
  });

  try {
    await transporter.verify();
    const latencyMs = Date.now() - startTime;
    transporter.close();

    return {
      sender_id: sender.id,
      email: sender.email,
      smtp_host: sender.smtp_host,
      smtp_port: sender.smtp_port,
      smtp_secure: sender.smtp_secure,
      reachable: true,
      authenticated: true,
      latency_ms: latencyMs,
      tls_active: true,
      response_message: 'SMTP handshake and authentication verified successfully with validated TLS certificate.',
      probed_at: probedAt,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    transporter.close();

    const { errorCode, reachable } = classifyProbeError(err);
    const sanitizedMessage = (err.message || 'SMTP probe failed').replace(
      sender.smtp_pass,
      '[REDACTED]'
    );

    return {
      sender_id: sender.id,
      email: sender.email,
      smtp_host: sender.smtp_host,
      smtp_port: sender.smtp_port,
      smtp_secure: sender.smtp_secure,
      reachable,
      authenticated: false,
      latency_ms: latencyMs,
      tls_active: false,
      response_message: 'SMTP probe connection failed.',
      error_code: errorCode,
      error_message: sanitizedMessage,
      probed_at: probedAt,
    };
  }
}
