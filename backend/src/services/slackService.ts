import { redis } from '../db/redis';
import { db as pool } from '../db/postgres';
import { CampaignRow } from '../types/db.types';
import { getSlackIntegrationByUserId } from './slackIntegrationService';

// For testing purposes to verify notifications without requiring a live Slack channel
export const testState = {
  sentNotifications: [] as { text: string; timestamp: number }[],
  mockSendFailure: false,
};

export function clearTestState() {
  testState.sentNotifications = [];
  testState.mockSendFailure = false;
}

/**
 * Sends a raw text message to Slack via Incoming Webhooks.
 * Implements validation, timeout, and safe error logging.
 *
 * @param text The message to send to Slack
 * @param customWebhookUrl Optional user-specific webhook URL
 */
export async function sendSlackNotification(
  text: string,
  customWebhookUrl?: string | null,
): Promise<void> {
  const webhookUrl = customWebhookUrl || process.env.SLACK_WEBHOOK_URL;

  // Track notifications for integration testing assertions
  testState.sentNotifications.push({ text, timestamp: Date.now() });

  if (testState.mockSendFailure) {
    throw new Error('Mocked Slack HTTP post failure');
  }

  if (!webhookUrl || webhookUrl.trim() === '') {
    // Return early if not configured, allowing local testing without a real Slack webhook
    console.warn('⚠️  [Slack] Slack webhook URL is not set. Skipping HTTP delivery.');
    return;
  }

  if (!webhookUrl.startsWith('https://hooks.slack.com/services/')) {
    throw new Error('Invalid Slack Webhook URL configuration: must start with "https://hooks.slack.com/services/"');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(webhookUrl, {
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
      throw new Error('Slack notification request timed out after 5 seconds');
    }
    throw error;
  }
}

/**
 * Handles the logic when a campaign hits its rate limit.
 * Implements deduplication using Redis and safely isolates the Slack trigger.
 *
 * Redis Key: slack:ratelimit:notified:<campaignId>:<windowEpoch>
 * TTL: waitMs (remaining window duration in ms)
 */
export async function handleRateLimitNotification(
  campaignId: string,
  hourlyLimit: number,
  waitMs: number,
): Promise<void> {
  try {
    // 1. Fetch campaign details to get user_id and Subject
    const campaignResult = await pool.query<CampaignRow>(
      'SELECT subject, user_id FROM campaigns WHERE id = $1',
      [campaignId],
    );
    const campaign = campaignResult.rows[0];
    if (!campaign) {
      console.warn(`⚠️  [Slack] Campaign ${campaignId} not found. Skipping rate-limit notification.`);
      return;
    }

    const userId = campaign.user_id;

    // 2. Resolve that user's Slack integration
    const integration = await getSlackIntegrationByUserId(userId);
    if (!integration) {
      // If not connected, skip notification safely
      console.log(`ℹ️  [Slack] User ${userId} has no active Slack integration. Skipping notification.`);
      return;
    }

    if (!integration.webhook_url) {
      console.warn(`⚠️  [Slack] Webhook URL is missing for user ${userId}'s Slack integration. Skipping notification.`);
      return;
    }

    // 3. Calculate the end of the current rate-limit window (deterministic epoch in seconds)
    const windowEpoch = Math.floor((Date.now() + waitMs) / 1000);
    const redisKey = `slack:ratelimit:notified:${campaignId}:${windowEpoch}`;

    // Set the key with a millisecond TTL (PX) and write only if not exists (NX)
    const ttlMs = Math.max(waitMs, 1000); // Enforce a minimum of 1s to prevent permanent keys
    const result = await redis.set(redisKey, '1', 'PX', ttlMs, 'NX');

    if (result !== 'OK') {
      // Notification already triggered during the current rate-limiting window
      return;
    }

    console.log(`📢 [Slack] Sending rate-limit notification for campaign ${campaignId} to user's Slack workspace...`);

    const campaignSubject = campaign.subject || 'Unknown Campaign';

    // 4. Format the Slack alert message
    const formattedReset = formatDuration(waitMs);
    const message = `🚦 *ReachInbox Rate Limit Alert*

*Campaign:* ${campaignSubject}
*Campaign ID:* ${campaignId}
*Limit:* ${hourlyLimit} emails/hour
*Status:* Limit reached
*Action:* Remaining jobs delayed
*Reset in:* ${formattedReset}`;

    // 5. Send Slack notification via user's private webhook URL
    await sendSlackNotification(message, integration.webhook_url);
    console.log(`✅ [Slack] Notification sent successfully for campaign ${campaignId}`);
  } catch (error: any) {
    // 6. Isolate error safely to never interrupt the core worker flow
    console.error(`❌ [Slack] Notification failed: ${error.message}`);
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
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

