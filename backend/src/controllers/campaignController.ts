/**
 * src/controllers/campaignController.ts
 *
 * HTTP handlers for campaign + recipient endpoints.
 *
 * Responsibilities:
 *  - Parse and validate the request body / params.
 *  - Extract the authenticated user ID from req.user (NEVER from req.body).
 *  - Delegate all database work to campaignService.
 *  - Respond with structured JSON.
 *
 * Validation rules:
 *  subject      – non-empty string, max 500 chars
 *  body         – non-empty string
 *  hourly_limit – integer, 1-1000
 *  scheduled_at – if provided, valid ISO 8601 date AND must be in the future.
 *                 Timestamps are interpreted as UTC internally.
 *                 Past timestamps are rejected with HTTP 400.
 *  recipients   – non-empty array, each with a valid email
 *  Duplicate recipient emails in the same request → 400 (case-insensitive)
 *  Email addresses are normalised to trimmed-lowercase before DB insertion.
 *
 * Timezone handling (Phase 9E):
 *  The API accepts any ISO 8601 string (e.g. "2024-01-01T12:00:00Z" or
 *  "2024-01-01T17:30:00+05:30"). `new Date(raw)` converts it to UTC.
 *  BullMQ delay arithmetic uses UTC epoch milliseconds.
 *  PostgreSQL stores it as TIMESTAMPTZ (UTC).
 */

import { Request, Response, NextFunction } from 'express';
import { UserRow, CampaignStatus } from '../types/db.types';
import {
  CreateCampaignInput,
  RecipientInput,
  UpdateCampaignInput,
  createCampaignWithRecipients,
  listCampaignsByUser,
  getCampaignWithRecipients,
  updateCampaign,
  deleteCampaignForUser,
  getRecipientsForCampaign,
} from '../services/campaignService';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

function isValidISODate(value: string): boolean {
  const d = new Date(value);
  return !isNaN(d.getTime());
}

/** Extract the authenticated user from req.user (guaranteed by requireAuth). */
function currentUser(req: Request): UserRow {
  return req.user as UserRow;
}

// ---------------------------------------------------------------------------
// POST /campaigns
// ---------------------------------------------------------------------------

export async function createCampaign(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const errors: string[] = [];

    // ── subject ───────────────────────────────────────────────────────────────
    const subject = typeof body['subject'] === 'string' ? body['subject'].trim() : '';
    if (!subject) errors.push('subject is required and must be a non-empty string');
    if (subject.length > 500) errors.push('subject must be 500 characters or fewer');

    // ── body (email content) ─────────────────────────────────────────────────
    const emailBody = typeof body['body'] === 'string' ? body['body'].trim() : '';
    if (!emailBody) errors.push('body is required and must be a non-empty string');

    // ── hourly_limit ──────────────────────────────────────────────────────────
    const rawLimit = body['hourly_limit'];
    let hourlyLimit = 5; // default
    if (rawLimit !== undefined && rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
        errors.push('hourly_limit must be an integer between 1 and 1000');
      } else {
        hourlyLimit = parsed;
      }
    }

    // ── scheduled_at ──────────────────────────────────────────────────────────
    // Phase 9E: scheduled_at must be a valid ISO 8601 date AND in the future.
    // We reject past timestamps to prevent silent no-op schedules.
    let scheduledAt: Date | null = null;
    const rawScheduled = body['scheduled_at'];
    if (rawScheduled !== undefined && rawScheduled !== null) {
      if (typeof rawScheduled !== 'string' || !isValidISODate(rawScheduled)) {
        errors.push('scheduled_at must be a valid ISO 8601 date-time string');
      } else {
        const parsed = new Date(rawScheduled as string);
        if (parsed.getTime() <= Date.now()) {
          errors.push(
            'scheduled_at must be a future timestamp (UTC). ' +
              'The provided time is in the past or is the current moment.',
          );
        } else {
          scheduledAt = parsed;
        }
      }
    }

    // ── recipients ────────────────────────────────────────────────────────────
    const rawRecipients = body['recipients'];
    if (!Array.isArray(rawRecipients) || rawRecipients.length === 0) {
      errors.push('recipients must be a non-empty array');
    }

    const recipients: RecipientInput[] = [];
    const seenEmails = new Set<string>();

    if (Array.isArray(rawRecipients)) {
      rawRecipients.forEach((r: unknown, i: number) => {
        if (typeof r !== 'object' || r === null) {
          errors.push(`recipients[${i}] must be an object`);
          return;
        }
        const rec = r as Record<string, unknown>;

        // Normalise email: trim whitespace, lowercase
        const rawEmail = typeof rec['email'] === 'string' ? rec['email'].trim().toLowerCase() : '';
        if (!rawEmail) {
          errors.push(`recipients[${i}].email is required`);
          return;
        }
        if (!isValidEmail(rawEmail)) {
          errors.push(`recipients[${i}].email "${rawEmail}" is not a valid email address`);
          return;
        }
        // Duplicate detection (case-insensitive; already lowercased)
        if (seenEmails.has(rawEmail)) {
          errors.push(`recipients[${i}].email "${rawEmail}" is a duplicate – each recipient email must be unique within a campaign`);
          return;
        }
        seenEmails.add(rawEmail);

        const name = typeof rec['name'] === 'string' ? rec['name'].trim() : undefined;
        recipients.push({ email: rawEmail, name: name || undefined });
      });
    }

    // ── sender_id ────────────────────────────────────────────────────────────
    const senderId = typeof body['sender_id'] === 'string' ? body['sender_id'].trim() : '';
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!senderId) {
      errors.push('sender_id is required');
    } else if (!UUID_RE.test(senderId)) {
      errors.push('sender_id must be a valid UUID');
    }

    if (errors.length > 0) {
      res.status(400).json({ error: 'Validation failed', details: errors });
      return;
    }

    const user = currentUser(req);

    const input: CreateCampaignInput = {
      senderId,
      subject,
      body: emailBody,
      scheduledAt,
      hourlyLimit,
      recipients,
    };

    const campaign = await createCampaignWithRecipients(user.id, input);
    res.status(201).json(campaign);
  } catch (err: any) {
    if (err.message && (err.message.includes('Invalid sender') || err.message.includes('Sender not found'))) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /campaigns
// ---------------------------------------------------------------------------

export async function listCampaigns(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = currentUser(req);
    const campaigns = await listCampaignsByUser(user.id);
    res.status(200).json(campaigns);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /campaigns/:id
// ---------------------------------------------------------------------------

export async function getCampaign(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = currentUser(req);
    const campaign = await getCampaignWithRecipients(req.params['id']!, user.id);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    res.status(200).json(campaign);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// PATCH /campaigns/:id
// ---------------------------------------------------------------------------

const ALLOWED_STATUSES: CampaignStatus[] = [
  'draft', 'scheduled', 'sending', 'sent', 'failed',
];

export async function patchCampaign(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const errors: string[] = [];
    const updates: UpdateCampaignInput = {};

    if (body['subject'] !== undefined) {
      const s = typeof body['subject'] === 'string' ? body['subject'].trim() : '';
      if (!s) errors.push('subject must be a non-empty string');
      else if (s.length > 500) errors.push('subject must be 500 characters or fewer');
      else updates.subject = s;
    }

    if (body['body'] !== undefined) {
      const b = typeof body['body'] === 'string' ? body['body'].trim() : '';
      if (!b) errors.push('body must be a non-empty string');
      else updates.body = b;
    }

    if (body['hourly_limit'] !== undefined) {
      const parsed = Number(body['hourly_limit']);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
        errors.push('hourly_limit must be an integer between 1 and 1000');
      } else {
        updates.hourlyLimit = parsed;
      }
    }

    if (body['scheduled_at'] !== undefined) {
      if (body['scheduled_at'] === null) {
        updates.scheduledAt = null;
      } else if (typeof body['scheduled_at'] !== 'string' || !isValidISODate(body['scheduled_at'])) {
        errors.push('scheduled_at must be a valid ISO 8601 date-time string or null');
      } else {
        const parsed = new Date(body['scheduled_at'] as string);
        if (parsed.getTime() <= Date.now()) {
          errors.push(
            'scheduled_at must be a future timestamp (UTC). ' +
              'The provided time is in the past or is the current moment.',
          );
        } else {
          updates.scheduledAt = parsed;
        }
      }
    }

    if (body['status'] !== undefined) {
      if (!ALLOWED_STATUSES.includes(body['status'] as CampaignStatus)) {
        errors.push(`status must be one of: ${ALLOWED_STATUSES.join(', ')}`);
      } else {
        updates.status = body['status'] as CampaignStatus;
      }
    }

    if (body['sender_id'] !== undefined) {
      const sid = typeof body['sender_id'] === 'string' ? body['sender_id'].trim() : '';
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!sid) {
        errors.push('sender_id must be a non-empty string');
      } else if (!UUID_RE.test(sid)) {
        errors.push('sender_id must be a valid UUID');
      } else {
        updates.senderId = sid;
      }
    }

    if (errors.length > 0) {
      res.status(400).json({ error: 'Validation failed', details: errors });
      return;
    }

    // Detect empty patch body (no recognised fields provided)
    if (Object.keys(updates).length === 0) {
      res.status(400).json({
        error: 'No valid fields provided for update',
        allowed: ['subject', 'body', 'scheduled_at', 'hourly_limit', 'status', 'sender_id'],
      });
      return;
    }

    const user = currentUser(req);
    const updated = await updateCampaign(req.params['id']!, user.id, updates);
    if (!updated) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    res.status(200).json(updated);
  } catch (err: any) {
    if (err.message && (err.message.includes('Invalid sender') || err.message.includes('Sender not found'))) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
}

// ---------------------------------------------------------------------------
// DELETE /campaigns/:id
// ---------------------------------------------------------------------------

export async function removeCampaign(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = currentUser(req);
    const deleted = await deleteCampaignForUser(req.params['id']!, user.id);
    if (!deleted) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    res.status(200).json({ message: 'Campaign deleted successfully' });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /campaigns/:id/recipients
// ---------------------------------------------------------------------------

export async function listRecipients(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = currentUser(req);
    const recipients = await getRecipientsForCampaign(req.params['id']!, user.id);
    if (!recipients) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    res.status(200).json(recipients);
  } catch (err) {
    next(err);
  }
}