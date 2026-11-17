/**
 * src/controllers/preflightController.ts
 *
 * HTTP controller for Smart Campaign Preflight & Delivery Forecast.
 *
 * Endpoints:
 *  - POST /campaigns/preflight
 *  - POST /campaigns/:id/preflight
 *  - POST /preflight
 *
 * Authentication & Security:
 *  - Requires valid session authentication (req.user from requireAuth).
 *  - Requests strictly scoped to the authenticated user's campaigns and senders.
 *  - Enforces payload size limits (rejects oversized uploads with 413).
 *  - Completely read-only: performs zero database mutations, queue publications, or rate-limit reservations.
 */

import { Request, Response, NextFunction } from 'express';
import { UserRow } from '../types/db.types';
import { runPreflight, DEFAULT_MAX_UPLOAD_SIZE } from '../services/preflightService';
import { RunPreflightInput } from '../types/preflight.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function currentUser(req: Request): UserRow {
  return req.user as UserRow;
}

function isValidISODate(value: string): boolean {
  const d = new Date(value);
  return !isNaN(d.getTime());
}

export async function preflightCampaignHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = currentUser(req);
    if (!user || !user.id) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const errors: string[] = [];

    // 1. Resolve Campaign ID (from URL parameter or body)
    const rawCampaignId = req.params['id'] || body['campaign_id'] || body['campaignId'];
    let campaignId: string | undefined = undefined;
    if (rawCampaignId !== undefined && rawCampaignId !== null && rawCampaignId !== '') {
      const trimmed = String(rawCampaignId).trim();
      if (!UUID_RE.test(trimmed)) {
        errors.push('campaign_id must be a valid UUID');
      } else {
        campaignId = trimmed;
      }
    }

    // 2. Resolve Sender ID
    const rawSenderId = body['sender_id'] || body['senderId'];
    let senderId: string | undefined = undefined;
    if (rawSenderId !== undefined && rawSenderId !== null && rawSenderId !== '') {
      const trimmed = String(rawSenderId).trim();
      if (!UUID_RE.test(trimmed)) {
        errors.push('sender_id must be a valid UUID');
      } else {
        senderId = trimmed;
      }
    }

    // 3. Resolve Hourly Limit
    const rawLimit = body['hourly_limit'] ?? body['hourlyLimit'];
    let hourlyLimit: number | undefined = undefined;
    if (rawLimit !== undefined && rawLimit !== null && rawLimit !== '') {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
        errors.push('hourly_limit must be an integer between 1 and 1000');
      } else {
        hourlyLimit = parsed;
      }
    }

    // 4. Resolve Scheduled At
    const rawScheduled = body['scheduled_at'] ?? body['scheduledAt'];
    let scheduledAt: string | undefined = undefined;
    if (rawScheduled !== undefined && rawScheduled !== null && rawScheduled !== '') {
      if (typeof rawScheduled !== 'string' || !isValidISODate(rawScheduled)) {
        errors.push('scheduled_at must be a valid ISO 8601 date-time string');
      } else {
        scheduledAt = rawScheduled;
      }
    }

    // 5. Resolve Content / Recipients
    const rawContent =
      body['csv_content'] ??
      body['file_content'] ??
      body['raw_text'] ??
      body['content'];

    let content: string | undefined = undefined;
    if (rawContent !== undefined && rawContent !== null) {
      if (typeof rawContent !== 'string') {
        errors.push('csv_content must be a string');
      } else {
        // Enforce max upload size (5MB)
        if (Buffer.byteLength(rawContent, 'utf8') > DEFAULT_MAX_UPLOAD_SIZE) {
          res.status(413).json({
            error: 'Payload too large',
            message: `Uploaded content exceeds maximum allowed size of ${Math.round(
              DEFAULT_MAX_UPLOAD_SIZE / (1024 * 1024)
            )}MB`,
          });
          return;
        }
        content = rawContent;
      }
    }

    const rawRecipients = body['recipients'];
    let recipients: any[] | undefined = undefined;
    if (rawRecipients !== undefined && rawRecipients !== null) {
      if (!Array.isArray(rawRecipients)) {
        errors.push('recipients must be an array');
      } else {
        recipients = rawRecipients;
      }
    }

    if (content === undefined && recipients === undefined) {
      errors.push('Either csv_content or recipients array is required');
    }

    if (errors.length > 0) {
      res.status(400).json({ error: 'Validation failed', details: errors });
      return;
    }

    const input: RunPreflightInput = {
      userId: user.id,
      senderId,
      campaignId,
      hourlyLimit,
      scheduledAt,
      content,
      recipients,
    };

    const result = await runPreflight(input);
    res.status(200).json(result);
  } catch (err: any) {
    if (
      err.message &&
      (err.message.includes('not found') || err.message.includes('access denied'))
    ) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err.message && err.message.includes('sender_id is required')) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
}
