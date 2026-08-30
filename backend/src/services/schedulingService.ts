/**
 * src/services/schedulingService.ts
 *
 * Phase 9E — Exact-Time Scheduling
 *
 * Responsible for translating a campaign's `scheduled_at` timestamp into one
 * BullMQ delayed job per recipient.  This is the ONLY place delay arithmetic
 * is performed — no polling, no cron, no setInterval.
 *
 * Design decisions:
 *  - If `scheduled_at` is null the job is enqueued immediately (delay = 0),
 *    preserving backward-compatibility with existing immediate-send campaigns.
 *  - `delayMs` is clamped to 0 so a timestamp that slipped just past "now"
 *    during a slow request is processed immediately rather than silently dropped.
 *  - Logs include `scheduledAt` and `delayMs` for observability but never
 *    contain SMTP passwords, Slack tokens, or OAuth secrets.
 *  - A queue error is propagated to the caller so the campaign controller
 *    can surface it appropriately.
 *
 * Timezone handling:
 *  - `scheduled_at` is stored as TIMESTAMPTZ in PostgreSQL (UTC).
 *  - `scheduledAt.getTime()` returns UTC epoch milliseconds.
 *  - `Date.now()` returns UTC epoch milliseconds.
 *  - Arithmetic is pure UTC — no timezone conversion needed.
 *
 * Clock skew assumption:
 *  - The API server and worker are expected to share the same system clock
 *    (or be reasonably synchronised via NTP).  No distributed clock sync
 *    is implemented.
 */

import { emailQueue, EmailJobPayload } from '../queue/emailQueue';
import { CampaignRow, RecipientRow } from '../types/db.types';

/**
 * Enqueues one BullMQ delayed job per recipient for the given campaign.
 *
 * @param campaign  - The persisted campaign row (must include `scheduled_at`).
 * @param recipients - All recipients belonging to this campaign.
 */
export async function scheduleEmailJobs(
  campaign: CampaignRow,
  recipients: RecipientRow[],
): Promise<void> {
  const scheduledAt = campaign.scheduled_at ? new Date(campaign.scheduled_at) : null;
  const now = Date.now();

  // Calculate delay in milliseconds. If no scheduled_at, fire immediately (delay = 0).
  const rawDelayMs = scheduledAt ? scheduledAt.getTime() - now : 0;
  const delayMs = Math.max(0, rawDelayMs); // never negative

  console.log(
    `[Scheduler] Scheduling campaign ${campaign.id} for ${recipients.length} recipient(s) [delayMs=${delayMs}]`,
  );
  if (scheduledAt) {
    console.log(`[Scheduler] scheduledAt=${scheduledAt.toISOString()}`);
  }

  for (const recipient of recipients) {
    const payload: EmailJobPayload = {
      campaignId: campaign.id,
      recipientId: recipient.id,
    };

    const job = await emailQueue.add('send-email', payload, {
      delay: delayMs,
      // Job-level options inherit queue defaults (attempts=3, backoff=exponential).
    });

    if (delayMs > 0) {
      const fireAt = new Date(now + delayMs).toISOString();
      console.log(
        `[Scheduler] Job ${job.id} delayed until ${fireAt} (recipient=${recipient.id})`,
      );
    } else {
      console.log(
        `[Scheduler] Job ${job.id} enqueued for immediate delivery (recipient=${recipient.id})`,
      );
    }
  }
}
