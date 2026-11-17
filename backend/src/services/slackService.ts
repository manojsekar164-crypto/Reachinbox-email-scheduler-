import { Pool, PoolClient } from 'pg';
import Redis from 'ioredis';
import { redis as defaultRedis } from '../db/redis';
import { db as defaultPool } from '../db/postgres';
import { CampaignRow } from '../types/db.types';
import { getSlackIntegrationByUserId } from './slackIntegrationService';

export interface RateLimitNotificationOptions {
  campaignId: string;
  reason: 'global' | 'sender' | 'campaign' | 'spacing';
  waitMs: number;
  campaignLimit?: number;
  senderId?: string | null;
  senderEmail?: string | null;
  senderLimit?: number | null;
  globalLimit?: number;
}

export type NotificationDeliveryState = 'reserved' | 'delivered' | 'uncertain';

export interface SentNotificationRecord {
  text: string;
  timestamp: number;
}

// For testing purposes to verify notifications without requiring a live Slack channel.
// Webhook URLs and tokens are strictly excluded from testState instrumentation.
export const testState = {
  sentNotifications: [] as SentNotificationRecord[],
  mockSendFailure: false,
  mockTimeoutFailure: false,
};

export function clearTestState() {
  testState.sentNotifications = [];
  testState.mockSendFailure = false;
  testState.mockTimeoutFailure = false;
}

/**
 * Sanitizes any message or error text to ensure webhook secret URLs or access tokens
 * are never leaked in logs, error objects, or test instrumentation.
 */
export function sanitizeSlackError(error: any): string {
  const rawMessage = typeof error === 'string' ? error : error?.message || 'Unknown error';
  return rawMessage
    .replace(/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_\-\/]+/gi, 'https://hooks.slack.com/services/[REDACTED_WEBHOOK_URL]')
    .replace(/xox[baprs]-[A-Za-z0-9\-]+/gi, '[REDACTED_SLACK_TOKEN]');
}

/**
 * Checks whether an error represents an uncertain Slack outcome (e.g. timeout or connection drop)
 * where the HTTP request may have reached Slack and been processed.
 */
export function isUncertainSlackError(error: any): boolean {
  if (!error) return false;
  if (error.name === 'AbortError' || error.name === 'SlackTimeoutError' || (error as any).isUncertain) {
    return true;
  }
  const msg = (error.message || '').toLowerCase();
  const code = (error.code || '').toLowerCase();
  if (
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('abort') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('etimedout')
  ) {
    return true;
  }
  if (code === 'etimedout' || code === 'econnreset' || code === 'esockettimedout') {
    return true;
  }
  return false;
}

/**
 * Sends a raw text message to Slack via Incoming Webhooks.
 * Implements validation, timeout, and safe error logging.
 *
 * @param text The message to send to Slack
 * @param customWebhookUrl Optional user-specific webhook URL
 * @param injectedFetch Optional fetch function for testing
 */
export async function sendSlackNotification(
  text: string,
  customWebhookUrl?: string | null,
  injectedFetch: typeof fetch = fetch,
): Promise<void> {
  const webhookUrl = customWebhookUrl || process.env.SLACK_WEBHOOK_URL;

  // Track notifications for testing assertions ONLY in non-production environments.
  // Webhook URLs and tokens are NEVER recorded in test arrays.
  if (process.env.NODE_ENV !== 'production') {
    testState.sentNotifications.push({ text, timestamp: Date.now() });

    if (testState.mockSendFailure) {
      throw new Error('Mocked Slack HTTP post failure');
    }
    if (testState.mockTimeoutFailure) {
      const timeoutErr = new Error('Mocked Slack timeout after 5 seconds');
      timeoutErr.name = 'AbortError';
      (timeoutErr as any).isUncertain = true;
      throw timeoutErr;
    }
  }

  if (!webhookUrl || webhookUrl.trim() === '') {
    console.warn('⚠️  [Slack] Slack webhook URL is not set. Skipping HTTP delivery.');
    return;
  }

  // Check for mock webhook URLs
  const isMockUrl = webhookUrl.includes('mock-webhook') || webhookUrl.includes('test');
  if (isMockUrl) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Mock webhook URLs are strictly forbidden in production environment.');
    }
    // Safe simulated delivery in test mode
    return;
  }

  if (!webhookUrl.startsWith('https://hooks.slack.com/services/')) {
    throw new Error('Invalid Slack Webhook URL configuration: must start with "https://hooks.slack.com/services/"');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await injectedFetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Slack API returned status ${response.status}: ${response.statusText}`);
    }
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      const timeoutErr = new Error('Slack notification request timed out after 5 seconds');
      timeoutErr.name = 'AbortError';
      (timeoutErr as any).isUncertain = true;
      throw timeoutErr;
    }
    throw new Error(sanitizeSlackError(error));
  }
}

/**
 * Handles rate-limit notifications for global, sender, and campaign constraints.
 * Implements deduplication using Redis and safely isolates the Slack trigger so
 * email deliveries are never blocked or retried on Slack failure.
 *
 * Fully backward-compatible with legacy handleRateLimitNotification(campaignId, hourlyLimit, waitMs).
 */
export async function handleRateLimitNotification(
  campaignIdOrOptions: string | RateLimitNotificationOptions,
  legacyHourlyLimit?: number,
  legacyWaitMs?: number,
  injectedPool: Pool | PoolClient = defaultPool,
  injectedRedis: Redis = defaultRedis,
  injectedSender?: (text: string, webhookUrl: string) => Promise<void>,
): Promise<void> {
  try {
    // Normalize options
    const options: RateLimitNotificationOptions =
      typeof campaignIdOrOptions === 'string'
        ? {
            campaignId: campaignIdOrOptions,
            reason: 'campaign',
            waitMs: legacyWaitMs ?? 3600000,
            campaignLimit: legacyHourlyLimit,
          }
        : campaignIdOrOptions;

    const { campaignId, reason, waitMs, campaignLimit, senderId, senderEmail, senderLimit } = options;

    // Minimum send spacing is normal sub-second pacing; do not trigger Slack alert
    if (reason === 'spacing') {
      return;
    }

    // 1. Fetch campaign details to resolve tenant user_id and subject
    const campaignResult = await injectedPool.query<CampaignRow>(
      'SELECT id, subject, user_id, hourly_limit FROM campaigns WHERE id = $1',
      [campaignId],
    );
    const campaign = campaignResult.rows[0];
    if (!campaign) {
      console.warn(`⚠️  [Slack] Campaign ${campaignId} not found. Skipping rate-limit notification.`);
      return;
    }

    const userId = campaign.user_id;

    // 2. Resolve tenant's Slack integration
    const integration = await getSlackIntegrationByUserId(userId, injectedPool);
    if (!integration) {
      console.log(`ℹ️  [Slack] User ${userId} has no active Slack integration. Skipping notification.`);
      return;
    }

    if (!integration.webhook_url) {
      console.warn(`⚠️  [Slack] Webhook URL is missing for user ${userId}'s Slack integration. Skipping notification.`);
      return;
    }

    // 3. Deduplication via Redis with explicit states: 'reserved', 'delivered', 'uncertain'
    const windowEpoch = Math.floor((Date.now() + waitMs) / 1000);
    let dedupKey: string;

    if (reason === 'global') {
      // Deduplicate per tenant per global window
      dedupKey = `slack:ratelimit:notified:global:${userId}:${windowEpoch}`;
    } else if (reason === 'sender') {
      // Deduplicate per sender per window
      dedupKey = `slack:ratelimit:notified:sender:${senderId || 'default'}:${windowEpoch}`;
    } else {
      // Deduplicate per campaign per window
      dedupKey = `slack:ratelimit:notified:campaign:${campaignId}:${windowEpoch}`;
    }

    // Acquire atomic reservation with an in-progress lease
    // This prevents concurrent duplicate notifications during HTTP dispatch
    const RESERVATION_LEASE_MS = 15000;
    let acquired: string | null = null;
    try {
      acquired = await injectedRedis.set(dedupKey, 'reserved', 'PX', RESERVATION_LEASE_MS, 'NX');
    } catch (redisErr) {
      console.warn(`⚠️  [Slack] Redis error checking notification reservation: ${sanitizeSlackError(redisErr)}`);
      // If Redis fails, return safely without failing email delivery
      return;
    }

    if (acquired !== 'OK') {
      // Slot already reserved, delivered, or uncertain within the active window
      return;
    }

    console.log(`📢 [Slack] Sending ${reason} rate-limit notification for campaign ${campaignId}...`);

    const formattedReset = formatDuration(waitMs);
    const campaignSubject = campaign.subject || 'Unknown Campaign';
    let message = '';

    // 4. Format rich Slack message based on rate-limit constraint
    if (reason === 'global') {
      message = `🚦 *ReachInbox Rate Limit Alert — Global Limit Reached*

*Event:* Global Hourly Delivery Limit Reached
*Campaign:* ${campaignSubject} (ID: ${campaignId})
*Reason:* Shared platform hourly email capacity limit reached. Outbound dispatches are temporarily paused.
*Expected Resume:* In ~${formattedReset}
*Action:* Dispatches will resume automatically once the shared capacity window resets.`;
    } else if (reason === 'sender') {
      const senderDisplay = senderEmail ? `${senderEmail} (${senderId || 'ID: unknown'})` : (senderId || 'Configured Sender');
      const limitDisplay = senderLimit !== undefined && senderLimit !== null ? `${senderLimit} emails/hour` : 'Configured Limit';
      message = `🚦 *ReachInbox Rate Limit Alert — Sender Limit Reached*

*Event:* Sender Hourly Delivery Limit Reached
*Sender:* ${senderDisplay}
*Campaign:* ${campaignSubject} (ID: ${campaignId})
*Limit:* ${limitDisplay}
*Reason:* Sender hourly sending limit exhausted.
*Expected Resume:* In ~${formattedReset}
*Action:* Dispatches from this sender are paused until the quota window resets.`;
    } else {
      const limitDisplay = (campaignLimit || campaign.hourly_limit) ? `${campaignLimit || campaign.hourly_limit} emails/hour` : 'Configured Limit';
      message = `🚦 *ReachInbox Rate Limit Alert — Campaign Limit Reached*

*Event:* Campaign Hourly Delivery Limit Reached
*Campaign:* ${campaignSubject} (ID: ${campaignId})
*Limit:* ${limitDisplay}
*Reason:* Campaign hourly sending limit exhausted.
*Expected Resume:* In ~${formattedReset}
*Action:* Remaining deliveries delayed until the next hourly window.`;
    }

    // 5. Send Slack notification via user's encrypted webhook URL
    const ttlMs = Math.max(waitMs, 1000);
    try {
      if (injectedSender) {
        await injectedSender(message, integration.webhook_url);
      } else {
        await sendSlackNotification(message, integration.webhook_url);
      }

      // SUCCESS: Transition state to 'delivered' with full window TTL
      try {
        await injectedRedis.set(dedupKey, 'delivered', 'PX', ttlMs);
      } catch {}
      console.log(`✅ [Slack] Notification sent successfully for campaign ${campaignId} (reason: ${reason})`);
    } catch (deliveryError: any) {
      const isUncertain = isUncertainSlackError(deliveryError);

      if (isUncertain) {
        // UNCERTAIN: Timeout or connection interruption after submission.
        // Record 'uncertain' with full window TTL to prevent uncontrolled duplicate spam.
        try {
          await injectedRedis.set(dedupKey, 'uncertain', 'PX', ttlMs);
        } catch {}
        console.warn(`⚠️  [Slack] Notification outcome is uncertain (timeout/network interruption) for campaign ${campaignId}: ${sanitizeSlackError(deliveryError)}`);
      } else {
        // DEFINITE FAILURE (e.g. HTTP 4xx, HTTP 500, invalid config):
        // Clear the reservation so valid alerts are NOT permanently suppressed for the whole rate-limit window.
        try {
          await injectedRedis.eval(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
            1,
            dedupKey,
            'reserved',
          );
        } catch {}
        console.error(`❌ [Slack] Notification failed: ${sanitizeSlackError(deliveryError)}`);
      }
    }
  } catch (error: any) {
    // 6. Safe error boundary: never fail worker processing or trigger email retries
    console.error(`❌ [Slack] Notification failed: ${sanitizeSlackError(error)}`);
  }
}

/**
 * Formats a duration in milliseconds to a readable hh:mm:ss format
 */
function formatDuration(ms: number): string {
  const totalSecs = Math.max(0, Math.ceil(ms / 1000));
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  const pad = (n: number) => String(n).padStart(2, '0');
  if (hrs > 0) {
    return `${pad(hrs)}h ${pad(mins)}m ${pad(secs)}s`;
  }
  return `${pad(mins)}m ${pad(secs)}s`;
}

/**
 * Sends a Slack notification when a new campaign is composed & queued.
 */
export async function notifyCampaignCreated(
  userId: string,
  subject: string,
  recipientCount: number,
  scheduledAtOrLimit?: Date | number | null,
): Promise<void> {
  try {
    const integration = await getSlackIntegrationByUserId(userId);
    if (!integration || !integration.webhook_url) return;

    let scheduleTime = 'Immediately';
    if (scheduledAtOrLimit instanceof Date) {
      scheduleTime = scheduledAtOrLimit.toLocaleString();
    } else if (typeof scheduledAtOrLimit === 'number') {
      scheduleTime = `Hourly Limit: ${scheduledAtOrLimit}/hr`;
    }

    const message = `🚀 *New Campaign Created!*
*Subject:* ${subject}
*Recipients:* ${recipientCount}
*Scheduled For:* ${scheduleTime}`;

    await sendSlackNotification(message, integration.webhook_url);
    console.log(`✅ [Slack] Campaign created notification sent for: ${subject}`);
  } catch (err: any) {
    console.warn(`⚠️ [Slack] Campaign created notification failed: ${sanitizeSlackError(err)}`);
  }
}

/**
 * Sends a Slack notification when all emails in a campaign are delivered.
 */
export async function notifyCampaignCompleted(
  userId: string,
  subjectOrCampaignId: string,
  totalSentOrSubject?: number | string,
): Promise<void> {
  try {
    const integration = await getSlackIntegrationByUserId(userId);
    if (!integration || !integration.webhook_url) return;

    let subject = subjectOrCampaignId;
    let detail = '';

    if (typeof totalSentOrSubject === 'string') {
      subject = totalSentOrSubject;
      detail = `*Campaign ID:* ${subjectOrCampaignId}`;
    } else if (typeof totalSentOrSubject === 'number') {
      detail = `*Total Sent:* ${totalSentOrSubject} emails`;
    }

    const message = `🎉 *Campaign Completed!*
*Subject:* ${subject}
${detail}`.trim();

    await sendSlackNotification(message, integration.webhook_url);
    console.log(`✅ [Slack] Campaign completed notification sent for: ${subject}`);
  } catch (err: any) {
    console.warn(`⚠️ [Slack] Campaign completed notification failed: ${sanitizeSlackError(err)}`);
  }
}
