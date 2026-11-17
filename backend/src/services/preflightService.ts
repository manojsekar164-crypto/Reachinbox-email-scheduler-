/**
 * src/services/preflightService.ts
 *
 * Smart Campaign Preflight & Delivery Forecast Service.
 *
 * Responsibilities:
 *  1. Recipient Validation Engine:
 *     - CSV and text recipient parsing (with BOM stripping, quote handling, and delimiter detection).
 *     - Standard email format validation.
 *     - Duplicate detection within uploaded data (case-insensitive).
 *     - Existing-recipient detection within the selected campaign (PostgreSQL check).
 *     - Row-level validation errors with informative reasons.
 *     - Summary counts (valid, invalid, duplicate, existing).
 *     - Safe handling of empty files, malformed syntax, missing email columns, and oversized uploads.
 *  2. Sender Capacity and Delivery Forecast Engine:
 *     - Sender-specific hourly capacity & remaining quota strictly from PostgreSQL.
 *     - Campaign-specific hourly capacity & remaining quota strictly from PostgreSQL.
 *     - Global hourly capacity & remaining quota (disabled if 0).
 *     - Minimum spacing constraint & theoretical max rate.
 *     - Queue backlog inspection (BullMQ active/waiting jobs).
 *     - Accurate reset wait estimation for exhausted limits (accounting for all required constraints).
 *     - Optional What-If forecasting scenario without mutating actual configured capacity.
 *
 * Invariants:
 *  - 100% READ-ONLY: Never inserts/modifies recipients, deliveries, attempts, outbox, or campaigns.
 *  - Never publishes jobs to BullMQ.
 *  - Never consumes or reserves Redis rate-limit tokens during preflight.
 *  - Clear identification of approximate forecast inputs, assumptions, and warnings.
 */

import { Pool, Client } from 'pg';
import { Redis } from 'ioredis';
import { db } from '../db/postgres';
import { redis as defaultRedis } from '../db/redis';
import { emailQueue } from '../queue/emailQueue';
import { getGlobalHourlyLimit } from './rateLimiter';
import { config } from '../config';
import {
  ValidRecipientRow,
  InvalidRecipientRow,
  DuplicateRecipientRow,
  ExistingRecipientRow,
  ValidationCounts,
  RecipientValidationResult,
  PreflightCapacityResult,
  DeliveryForecastResult,
  WhatIfScenarioResult,
  PreflightResult,
  RunPreflightInput,
  RecipientInputItem,
  BottleneckReason,
} from '../types/preflight.types';
import { SenderRow, CampaignRow } from '../types/db.types';

// Standard project email format validation regex
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const DEFAULT_MAX_UPLOAD_SIZE = 5 * 1024 * 1024; // 5 MB

export function isValidEmailFormat(email: string): boolean {
  return EMAIL_RE.test(email);
}

// ---------------------------------------------------------------------------
// CSV / Text Parser Implementation
// ---------------------------------------------------------------------------

/**
 * Splits a single CSV/delimited line into string tokens, handling quotes and commas/semicolons.
 */
function parseDelimitedLine(line: string, delimiter: string = ','): string[] {
  const tokens: string[] = [];
  let currentToken = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        // Escaped quote ("")
        currentToken += '"';
        i += 2;
        continue;
      }
      // Toggle quote state
      inQuotes = !inQuotes;
      i++;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      tokens.push(currentToken.trim());
      currentToken = '';
      i++;
      continue;
    }

    currentToken += char;
    i++;
  }

  tokens.push(currentToken.trim());
  return tokens;
}

/**
 * Detects the most probable delimiter for CSV/text lines: comma, semicolon, or tab.
 */
function detectDelimiter(lines: string[]): string {
  let commaCount = 0;
  let semiCount = 0;
  let tabCount = 0;

  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const line = lines[i] || '';
    commaCount += (line.match(/,/g) || []).length;
    semiCount += (line.match(/;/g) || []).length;
    tabCount += (line.match(/\t/g) || []).length;
  }

  if (tabCount > commaCount && tabCount > semiCount) return '\t';
  if (semiCount > commaCount && semiCount > tabCount) return ';';
  return ',';
}

/**
 * Parses raw CSV or line-delimited text into structured recipient tokens.
 */
export function parseRawContent(
  rawContent: string,
  maxUploadSizeBytes: number = DEFAULT_MAX_UPLOAD_SIZE
): {
  rows: Array<{ rowNumber: number; email: string; name?: string; raw: string }>;
  headerFound: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // 1. Oversized Upload Check
  if (Buffer.byteLength(rawContent, 'utf8') > maxUploadSizeBytes) {
    errors.push(`Uploaded content exceeds maximum allowed size of ${Math.round(maxUploadSizeBytes / (1024 * 1024))}MB`);
    return { rows: [], headerFound: false, errors };
  }

  // 2. Binary / Malformed Encoding Check
  if (rawContent.includes('\0')) {
    errors.push('Malformed or unreadable content (binary or null byte detected)');
    return { rows: [], headerFound: false, errors };
  }

  // 3. UTF-8 BOM Stripping
  let cleaned = rawContent;
  if (cleaned.charCodeAt(0) === 0xfeff) {
    cleaned = cleaned.slice(1);
  }

  // 4. Split into non-empty trimmed lines
  const rawLines = cleaned.split(/\r?\n/);
  const nonEmptyLines: { line: string; originalIndex: number }[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = (rawLines[i] || '').trim();
    if (trimmed.length > 0) {
      nonEmptyLines.push({ line: rawLines[i]!, originalIndex: i + 1 });
    }
  }

  if (nonEmptyLines.length === 0) {
    errors.push('File or recipient content is empty');
    return { rows: [], headerFound: false, errors };
  }

  const delimiter = detectDelimiter(nonEmptyLines.map((l) => l.line));
  const firstLine = nonEmptyLines[0]!;
  const firstTokens = parseDelimitedLine(firstLine.line, delimiter);

  // 5. Header Detection
  let emailColIdx = -1;
  let nameColIdx = -1;
  let isHeader = false;

  for (let col = 0; col < firstTokens.length; col++) {
    const headerToken = (firstTokens[col] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      headerToken === 'email' ||
      headerToken === 'emailaddress' ||
      headerToken === 'recipient' ||
      headerToken === 'recipientemail' ||
      headerToken === 'mail' ||
      headerToken === 'to'
    ) {
      emailColIdx = col;
      isHeader = true;
    } else if (
      headerToken === 'name' ||
      headerToken === 'fullname' ||
      headerToken === 'recipientname' ||
      headerToken === 'firstname'
    ) {
      nameColIdx = col;
    }
  }

  // Check if first line appears to be a header of another schema without an email column
  if (!isHeader && firstTokens.length > 1) {
    const looksLikeSchemaHeader = firstTokens.some((t) =>
      /^(name|first|last|id|phone|address|company|age|title|city|state|zip)$/i.test(t.trim())
    );
    if (looksLikeSchemaHeader) {
      errors.push("Missing required email column in CSV header. Expected a column named 'email'.");
      return { rows: [], headerFound: true, errors };
    }
  }

  const resultRows: Array<{ rowNumber: number; email: string; name?: string; raw: string }> = [];
  const startIdx = isHeader ? 1 : 0;

  for (let i = startIdx; i < nonEmptyLines.length; i++) {
    const { line, originalIndex } = nonEmptyLines[i]!;
    const tokens = parseDelimitedLine(line, delimiter);

    let emailVal = '';
    let nameVal: string | undefined = undefined;

    if (isHeader) {
      emailVal = (tokens[emailColIdx] || '').trim();
      if (nameColIdx !== -1 && tokens[nameColIdx]) {
        nameVal = tokens[nameColIdx]!.trim() || undefined;
      }
    } else {
      // Headerless: detect which token looks like an email or fallback to column 0
      const atIndex = tokens.findIndex((t) => t.includes('@'));
      if (atIndex !== -1) {
        emailVal = tokens[atIndex]!.trim();
        const otherIndex = atIndex === 0 ? 1 : 0;
        if (tokens[otherIndex]) {
          nameVal = tokens[otherIndex]!.trim() || undefined;
        }
      } else {
        emailVal = (tokens[0] || '').trim();
        if (tokens[1]) {
          nameVal = tokens[1]!.trim() || undefined;
        }
      }
    }

    resultRows.push({
      rowNumber: originalIndex,
      email: emailVal,
      name: nameVal,
      raw: line,
    });
  }

  return {
    rows: resultRows,
    headerFound: isHeader,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Recipient Validation Engine
// ---------------------------------------------------------------------------

export interface ValidateRecipientsOptions {
  userId: string;
  campaignId?: string | null;
  rawContent?: string;
  recipients?: RecipientInputItem[];
  maxUploadSizeBytes?: number;
}

/**
 * Validates a list of recipients from CSV/text content or structured objects.
 * Identifies valid, invalid, duplicate, and existing campaign recipients.
 *
 * Invariant: Completely read-only. Inserts zero records.
 */
export async function validateRecipients(
  options: ValidateRecipientsOptions,
  dbClient: Pool | Client = db
): Promise<RecipientValidationResult> {
  const { userId, campaignId, rawContent, recipients, maxUploadSizeBytes } = options;

  const valid: ValidRecipientRow[] = [];
  const invalid: InvalidRecipientRow[] = [];
  const duplicates: DuplicateRecipientRow[] = [];
  const existing: ExistingRecipientRow[] = [];
  const errors: string[] = [];

  // 1. Fetch Existing Recipients for Selected Campaign (if campaignId is provided)
  const existingCampaignEmails = new Set<string>();
  if (campaignId) {
    // Verify campaign belongs to the authenticated user
    const campResult = await dbClient.query<CampaignRow>(
      `SELECT id FROM campaigns WHERE id = $1 AND user_id = $2`,
      [campaignId, userId]
    );

    if (campResult.rows.length === 0) {
      errors.push(`Campaign ${campaignId} not found or access denied`);
    } else {
      const recResult = await dbClient.query<{ email: string }>(
        `SELECT lower(email) AS email FROM recipients WHERE campaign_id = $1`,
        [campaignId]
      );
      for (const row of recResult.rows) {
        if (row.email) {
          existingCampaignEmails.add(row.email.trim().toLowerCase());
        }
      }
    }
  }

  // 2. Collect Candidate Rows (from CSV content or JSON recipients)
  const candidateRows: Array<{ rowNumber: number; email: string; name?: string; raw?: string }> = [];

  if (rawContent !== undefined && rawContent !== null) {
    const parsed = parseRawContent(rawContent, maxUploadSizeBytes);
    if (parsed.errors.length > 0) {
      errors.push(...parsed.errors);
      return {
        counts: {
          total_rows: 0,
          valid_count: 0,
          invalid_count: 0,
          duplicate_count: 0,
          existing_count: 0,
        },
        valid,
        invalid,
        duplicates,
        existing,
        errors,
      };
    }
    candidateRows.push(...parsed.rows);
  } else if (Array.isArray(recipients)) {
    if (recipients.length === 0) {
      errors.push('Recipient list is empty');
      return {
        counts: {
          total_rows: 0,
          valid_count: 0,
          invalid_count: 0,
          duplicate_count: 0,
          existing_count: 0,
        },
        valid,
        invalid,
        duplicates,
        existing,
        errors,
      };
    }
    recipients.forEach((item, idx) => {
      candidateRows.push({
        rowNumber: idx + 1,
        email: typeof item.email === 'string' ? item.email : '',
        name: typeof item.name === 'string' ? item.name : undefined,
        raw: JSON.stringify(item),
      });
    });
  } else {
    errors.push('No recipient content or recipients array provided');
    return {
      counts: {
        total_rows: 0,
        valid_count: 0,
        invalid_count: 0,
        duplicate_count: 0,
        existing_count: 0,
      },
      valid,
      invalid,
      duplicates,
      existing,
      errors,
    };
  }

  // 3. Process and Classify Each Row
  const seenInUpload = new Set<string>();

  for (const item of candidateRows) {
    const rawEmail = (item.email || '').trim();
    const normalizedEmail = rawEmail.toLowerCase();

    // Check empty email
    if (!rawEmail) {
      invalid.push({
        row: item.rowNumber,
        email: rawEmail,
        reason: 'Empty or missing email address',
        raw: item.raw,
      });
      continue;
    }

    // Check email syntax (Accurate description: standard email address format)
    if (!isValidEmailFormat(normalizedEmail)) {
      invalid.push({
        row: item.rowNumber,
        email: rawEmail,
        reason: 'Invalid email address format',
        raw: item.raw,
      });
      continue;
    }

    // Check duplicate within uploaded data
    if (seenInUpload.has(normalizedEmail)) {
      duplicates.push({
        row: item.rowNumber,
        email: normalizedEmail,
        reason: 'Duplicate email address within uploaded data',
        raw: item.raw,
      });
      continue;
    }
    seenInUpload.add(normalizedEmail);

    // Check existing in selected campaign
    if (existingCampaignEmails.has(normalizedEmail)) {
      existing.push({
        row: item.rowNumber,
        email: normalizedEmail,
        reason: 'Recipient already exists in this campaign',
        raw: item.raw,
      });
      continue;
    }

    // Row is Valid
    valid.push({
      row: item.rowNumber,
      email: normalizedEmail,
      name: item.name ? item.name.trim() : undefined,
    });
  }

  const counts: ValidationCounts = {
    total_rows: candidateRows.length,
    valid_count: valid.length,
    invalid_count: invalid.length,
    duplicate_count: duplicates.length,
    existing_count: existing.length,
  };

  return {
    counts,
    valid,
    invalid,
    duplicates,
    existing,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Rate-Limit Reset Estimation Engine (Bug 2 Fix)
// ---------------------------------------------------------------------------

export interface ResetWaitResult {
  resetWaitMs: number;
  exhaustedConstraints: BottleneckReason[];
}

/**
 * Accurately determines which constraints are exhausted and calculates the
 * required reset waiting time using the maximum TTL of all exhausted constraints.
 *
 * Invariant: Never uses the minimum TTL of unrelated non-exhausted counters.
 */
export function calculateResetWait(
  currentHourRemaining: number,
  recipientCount: number,
  constraints: {
    campaign: { remaining: number; ttlSeconds: number };
    sender: { remaining: number; ttlSeconds: number };
    global: { enabled: boolean; remaining: number | null; ttlSeconds: number };
  }
): ResetWaitResult {
  const exhaustedConstraints: BottleneckReason[] = [];
  const relevantTtls: number[] = [];

  if (currentHourRemaining <= 0) {
    // Current hour is already blocked before any sends in this batch
    if (constraints.campaign.remaining <= 0) {
      exhaustedConstraints.push('campaign_hourly_limit');
      relevantTtls.push(constraints.campaign.ttlSeconds);
    }
    if (constraints.sender.remaining <= 0) {
      exhaustedConstraints.push('sender_hourly_limit');
      relevantTtls.push(constraints.sender.ttlSeconds);
    }
    if (
      constraints.global.enabled &&
      constraints.global.remaining !== null &&
      constraints.global.remaining <= 0
    ) {
      exhaustedConstraints.push('global_hourly_limit');
      relevantTtls.push(constraints.global.ttlSeconds);
    }
  } else if (recipientCount > currentHourRemaining) {
    // Spillover: current batch sends currentHourRemaining in hour 1, exhausting any constraint whose remaining === currentHourRemaining
    if (constraints.campaign.remaining === currentHourRemaining) {
      exhaustedConstraints.push('campaign_hourly_limit');
      relevantTtls.push(constraints.campaign.ttlSeconds);
    }
    if (constraints.sender.remaining === currentHourRemaining) {
      exhaustedConstraints.push('sender_hourly_limit');
      relevantTtls.push(constraints.sender.ttlSeconds);
    }
    if (
      constraints.global.enabled &&
      constraints.global.remaining !== null &&
      constraints.global.remaining === currentHourRemaining
    ) {
      exhaustedConstraints.push('global_hourly_limit');
      relevantTtls.push(constraints.global.ttlSeconds);
    }
  }

  if (relevantTtls.length === 0) {
    return { resetWaitMs: 0, exhaustedConstraints: [] };
  }

  // To allow sending, ALL exhausted constraints must permit sending -> maximum of relevant TTLs
  const maxTtlSec = Math.max(...relevantTtls);
  return {
    resetWaitMs: maxTtlSec * 1000,
    exhaustedConstraints,
  };
}

// ---------------------------------------------------------------------------
// Sender Capacity & Delivery Forecast Engine (Bug 1 & 2 Fixes)
// ---------------------------------------------------------------------------

export interface CalculateCapacityOptions {
  userId: string;
  senderId: string;
  campaignId?: string | null;
  hourlyLimit?: number | null;
  scheduledAt?: string | Date | null;
  recipientCount: number;
}

/**
 * Calculates real-time sender, campaign, global, and spacing capacity,
 * and generates an approximate multi-hour delivery completion forecast.
 *
 * Invariants:
 *  - Actual configured capacity strictly derived from authorized PostgreSQL records.
 *  - Client-supplied hourly_limit cannot overwrite configured campaign limit.
 *  - If what-if simulation is provided, it is exposed as a separate scenario.
 *  - 100% read-only.
 */
export async function calculateCapacityAndForecast(
  options: CalculateCapacityOptions,
  dbClient: Pool | Client = db,
  redisClient: Redis = defaultRedis
): Promise<{
  capacity: PreflightCapacityResult;
  forecast: DeliveryForecastResult;
  whatIfScenario?: WhatIfScenarioResult | null;
}> {
  const { userId, senderId, campaignId, hourlyLimit, scheduledAt, recipientCount } = options;

  // 1. Fetch & Verify Sender strictly from PostgreSQL
  const senderRes = await dbClient.query<SenderRow>(
    `SELECT * FROM senders WHERE id = $1 AND user_id = $2`,
    [senderId, userId]
  );

  if (senderRes.rows.length === 0) {
    throw new Error(`Sender not found or access denied (${senderId})`);
  }
  const sender = senderRes.rows[0]!;
  // Sender limit strictly derived from PostgreSQL record
  const senderLimit = sender.hourly_limit && sender.hourly_limit > 0 ? sender.hourly_limit : 100;

  // 2. Fetch Campaign strictly from PostgreSQL (Bug 1 Fix)
  let campaignLimit = 5; // default fallback for new campaign drafts
  let isExistingCampaign = false;

  if (campaignId) {
    const campRes = await dbClient.query<CampaignRow>(
      `SELECT * FROM campaigns WHERE id = $1 AND user_id = $2`,
      [campaignId, userId]
    );
    if (campRes.rows.length === 0) {
      throw new Error(`Campaign not found or access denied (${campaignId})`);
    }
    const campaign = campRes.rows[0]!;
    // Configure limit strictly from PostgreSQL record (never overridden by client param)
    campaignLimit = campaign.hourly_limit && campaign.hourly_limit > 0 ? campaign.hourly_limit : 5;
    isExistingCampaign = true;
  } else if (hourlyLimit && Number.isInteger(hourlyLimit) && hourlyLimit > 0) {
    // Only pre-creation drafts without an existing campaign record use the requested limit
    campaignLimit = hourlyLimit;
  }

  // 3. Sender Redis Hourly Usage (Read-Only)
  const senderKey = `rate-limit:sender:${sender.id}`;
  const rawSenderUsed = await redisClient.get(senderKey);
  const senderUsed = rawSenderUsed ? parseInt(rawSenderUsed, 10) : 0;
  const rawSenderTtl = await redisClient.ttl(senderKey);
  const senderTtlSeconds = rawSenderTtl > 0 ? rawSenderTtl : 3600;
  const senderRemaining = Math.max(0, senderLimit - senderUsed);

  // 4. Campaign Redis Hourly Usage (Read-Only)
  let campaignUsed = 0;
  let campaignTtlSeconds = 3600;
  if (campaignId) {
    const campaignKey = `rate-limit:campaign:${campaignId}`;
    const rawCampUsed = await redisClient.get(campaignKey);
    campaignUsed = rawCampUsed ? parseInt(rawCampUsed, 10) : 0;
    const rawCampTtl = await redisClient.ttl(campaignKey);
    campaignTtlSeconds = rawCampTtl > 0 ? rawCampTtl : 3600;
  }
  const campaignRemaining = Math.max(0, campaignLimit - campaignUsed);

  // 5. Global Redis Hourly Usage (Read-Only)
  const globalLimit = getGlobalHourlyLimit();
  const globalEnabled = globalLimit > 0;
  const globalKey = 'rate-limit:global';
  const rawGlobalUsed = await redisClient.get(globalKey);
  const globalUsed = rawGlobalUsed ? parseInt(rawGlobalUsed, 10) : 0;
  const rawGlobalTtl = await redisClient.ttl(globalKey);
  const globalTtlSeconds = rawGlobalTtl > 0 ? rawGlobalTtl : 3600;
  const globalRemaining = globalEnabled ? Math.max(0, globalLimit - globalUsed) : null;

  // 6. Minimum Send Spacing Constraint (Read-Only)
  const sendDelayMs =
    process.env['EMAIL_SEND_DELAY_MS'] !== undefined && process.env['EMAIL_SEND_DELAY_MS'] !== ''
      ? parseInt(process.env['EMAIL_SEND_DELAY_MS'], 10)
      : config.app.emailSendDelayMs || 2000;

  const spacingKey = 'email-send:global:last-send';
  const rawLastSend = await redisClient.get(spacingKey);
  const lastSendTime = rawLastSend ? parseInt(rawLastSend, 10) : 0;
  const now = Date.now();
  const currentSpacingWaitMs =
    lastSendTime > 0 && now - lastSendTime < sendDelayMs ? (lastSendTime + sendDelayMs) - now : 0;

  const maxSpacingHourlyRate = sendDelayMs > 0 ? Math.floor(3600000 / sendDelayMs) : 3600;

  // 7. Queued Work (Active / Waiting Jobs in BullMQ)
  let queuedJobsCount = 0;
  try {
    const counts = await emailQueue.getJobCounts('waiting', 'active');
    queuedJobsCount = (counts['waiting'] || 0) + (counts['active'] || 0);
  } catch (err: any) {
    queuedJobsCount = 0;
  }

  // 8. Effective Hourly Rate & Primary Bottleneck
  const ratesToCompare: Array<{ rate: number; reason: BottleneckReason }> = [
    { rate: campaignLimit, reason: 'campaign_hourly_limit' },
    { rate: senderLimit, reason: 'sender_hourly_limit' },
    { rate: maxSpacingHourlyRate, reason: 'minimum_spacing' },
  ];
  if (globalEnabled && globalLimit > 0) {
    ratesToCompare.push({ rate: globalLimit, reason: 'global_hourly_limit' });
  }

  ratesToCompare.sort((a, b) => a.rate - b.rate);
  const effectiveHourlyRate = ratesToCompare[0]!.rate;
  const primaryBottleneck = ratesToCompare[0]!.reason;

  // Current hour available slots across all active constraints
  const currentHourLimits = [campaignRemaining, senderRemaining];
  if (globalEnabled && globalRemaining !== null) {
    currentHourLimits.push(globalRemaining);
  }
  const currentHourRemaining = Math.max(0, Math.min(...currentHourLimits));

  const capacity: PreflightCapacityResult = {
    sender: {
      id: sender.id,
      email: sender.email,
      hourly_limit: senderLimit,
      current_used: senderUsed,
      remaining_hourly: senderRemaining,
      window_ttl_seconds: senderTtlSeconds,
    },
    campaign: {
      hourly_limit: campaignLimit,
      current_used: campaignUsed,
      remaining_hourly: campaignRemaining,
      window_ttl_seconds: campaignTtlSeconds,
    },
    global: {
      hourly_limit: globalLimit,
      current_used: globalUsed,
      remaining_hourly: globalRemaining,
      enabled: globalEnabled,
      window_ttl_seconds: globalTtlSeconds,
    },
    spacing: {
      min_delay_ms: sendDelayMs,
      max_hourly_rate: maxSpacingHourlyRate,
      current_wait_ms: currentSpacingWaitMs,
    },
    queued_work: {
      active_or_waiting_jobs: queuedJobsCount,
    },
    effective_hourly_rate: effectiveHourlyRate,
    current_hour_remaining: currentHourRemaining,
    primary_bottleneck: primaryBottleneck,
  };

  // 9. Delivery Forecast Calculation (Bug 2 Fix)
  const N = recipientCount;
  let startMs = now;

  if (scheduledAt) {
    const parsedScheduled = new Date(scheduledAt);
    if (!isNaN(parsedScheduled.getTime()) && parsedScheduled.getTime() > now) {
      startMs = parsedScheduled.getTime();
    } else {
      startMs = now + currentSpacingWaitMs;
    }
  } else {
    startMs = now + currentSpacingWaitMs;
  }

  let durationMs = 0;
  const assumptions: string[] = [
    'Assumes standard network latency and responsive SMTP provider.',
    'Assumes zero transient SMTP rejections (4xx) or exponential retry backoff delays.',
    'Assumes no conflicting external campaigns consume shared sender or global hourly quota.',
    'Assumes background worker process is running and actively dispatching queue jobs.',
  ];
  const warnings: string[] = [];

  const resetWaitInfo = calculateResetWait(currentHourRemaining, N, {
    campaign: { remaining: campaignRemaining, ttlSeconds: campaignTtlSeconds },
    sender: { remaining: senderRemaining, ttlSeconds: senderTtlSeconds },
    global: { enabled: globalEnabled, remaining: globalRemaining, ttlSeconds: globalTtlSeconds },
  });

  if (N === 0) {
    durationMs = 0;
  } else {
    // Physical spacing duration
    const spacingDurationMs = (N - 1) * sendDelayMs;
    const queueDelayMs = queuedJobsCount * sendDelayMs;

    let rateDurationMs = 0;

    if (currentHourRemaining <= 0) {
      // Entire batch must wait for all exhausted constraints to reset
      const resetWaitMs = resetWaitInfo.resetWaitMs;
      const fullHours = Math.floor((N - 1) / effectiveHourlyRate);
      const remInLastHour = (N - 1) % effectiveHourlyRate;
      rateDurationMs = resetWaitMs + fullHours * 3600000 + remInLastHour * sendDelayMs;

      const constraintNames = resetWaitInfo.exhaustedConstraints
        .map((c) => c.replace(/_/g, ' '))
        .join(' and ');
      warnings.push(
        `Current hourly rate limit is exhausted for ${constraintNames}. ` +
          `Deliveries will begin dispatching after window reset in approximately ${Math.ceil(resetWaitMs / 60000)} minutes.`
      );
    } else if (N <= currentHourRemaining) {
      // All recipients fit within the current hour window
      rateDurationMs = spacingDurationMs;
    } else {
      // Spillover into subsequent hours
      const resetWaitMs = resetWaitInfo.resetWaitMs;
      const firstHourSent = currentHourRemaining;
      const spillover = N - firstHourSent;

      const additionalFullHours = Math.floor((spillover - 1) / effectiveHourlyRate);
      const remInLastHour = ((spillover - 1) % effectiveHourlyRate) + 1;

      rateDurationMs =
        resetWaitMs +
        additionalFullHours * 3600000 +
        (remInLastHour - 1) * sendDelayMs;

      const constraintNames = resetWaitInfo.exhaustedConstraints
        .map((c) => c.replace(/_/g, ' '))
        .join(' and ');
      warnings.push(
        `Recipient count (${N}) exceeds current hour remaining capacity (${currentHourRemaining}). ` +
          `Delivery will span multiple hours due to ${constraintNames} limit.`
      );
    }

    durationMs = Math.max(spacingDurationMs, rateDurationMs) + queueDelayMs;
  }

  if (queuedJobsCount > 0) {
    warnings.push(
      `${queuedJobsCount} job(s) currently queued ahead in email-queue. Estimated completion accounts for backlog.`
    );
  }

  const estimatedStartAt = new Date(startMs).toISOString();
  const estimatedCompletionAt = new Date(startMs + durationMs).toISOString();
  const estimatedDurationSeconds = Math.ceil(durationMs / 1000);

  const forecast: DeliveryForecastResult = {
    recipient_count: N,
    estimated_start_at: estimatedStartAt,
    estimated_completion_at: estimatedCompletionAt,
    estimated_duration_seconds: estimatedDurationSeconds,
    is_approximate: true,
    confidence: 'approximate',
    assumptions,
    warnings,
  };

  // 10. Separate What-If Scenario Calculation (Batch 5.2 Fix)
  let whatIfScenario: WhatIfScenarioResult | null = null;
  if (
    isExistingCampaign &&
    hourlyLimit &&
    Number.isInteger(hourlyLimit) &&
    hourlyLimit > 0 &&
    hourlyLimit !== campaignLimit
  ) {
    // 1. Calculate simulated campaign remaining capacity bounded at zero
    const simulatedCampaignRemaining = Math.max(0, hourlyLimit - campaignUsed);

    // 2. Compare simulated campaign capacity against actual sender and global remaining capacity
    const simHourLimits = [simulatedCampaignRemaining, senderRemaining];
    if (globalEnabled && globalRemaining !== null) {
      simHourLimits.push(globalRemaining);
    }
    const simulatedCurrentHourRemaining = Math.max(0, Math.min(...simHourLimits));

    // 3. Calculate simulated effective rate and bottleneck independently
    const simRates: Array<{ rate: number; reason: BottleneckReason }> = [
      { rate: hourlyLimit, reason: 'campaign_hourly_limit' },
      { rate: senderLimit, reason: 'sender_hourly_limit' },
      { rate: maxSpacingHourlyRate, reason: 'minimum_spacing' },
    ];
    if (globalEnabled && globalLimit > 0) {
      simRates.push({ rate: globalLimit, reason: 'global_hourly_limit' });
    }
    simRates.sort((a, b) => a.rate - b.rate);
    const simEffectiveRate = simRates[0]!.rate;
    const simBottleneck = simRates[0]!.reason;

    // 4. Do not reuse actual campaign exhaustion or reset-wait assumptions when they differ
    const simResetWaitInfo = calculateResetWait(simulatedCurrentHourRemaining, N, {
      campaign: { remaining: simulatedCampaignRemaining, ttlSeconds: campaignTtlSeconds },
      sender: { remaining: senderRemaining, ttlSeconds: senderTtlSeconds },
      global: { enabled: globalEnabled, remaining: globalRemaining, ttlSeconds: globalTtlSeconds },
    });

    let simDurationMs = 0;
    if (N > 0) {
      const spacingDurationMs = (N - 1) * sendDelayMs;
      let simRateDurationMs = 0;

      if (simulatedCurrentHourRemaining <= 0) {
        const fullHours = Math.floor((N - 1) / simEffectiveRate);
        const rem = (N - 1) % simEffectiveRate;
        simRateDurationMs = simResetWaitInfo.resetWaitMs + fullHours * 3600000 + rem * sendDelayMs;
      } else if (N <= simulatedCurrentHourRemaining) {
        simRateDurationMs = spacingDurationMs;
      } else {
        const spillover = N - simulatedCurrentHourRemaining;
        const fullHours = Math.floor((spillover - 1) / simEffectiveRate);
        const rem = ((spillover - 1) % simEffectiveRate) + 1;
        simRateDurationMs = simResetWaitInfo.resetWaitMs + fullHours * 3600000 + (rem - 1) * sendDelayMs;
      }
      simDurationMs = Math.max(spacingDurationMs, simRateDurationMs) + queuedJobsCount * sendDelayMs;
    }

    whatIfScenario = {
      simulated_hourly_limit: hourlyLimit,
      simulated_campaign_remaining: simulatedCampaignRemaining,
      simulated_current_hour_remaining: simulatedCurrentHourRemaining,
      effective_hourly_rate: simEffectiveRate,
      primary_bottleneck: simBottleneck,
      estimated_duration_seconds: Math.ceil(simDurationMs / 1000),
      estimated_completion_at: new Date(startMs + simDurationMs).toISOString(),
    };
  }

  return { capacity, forecast, whatIfScenario };
}

// ---------------------------------------------------------------------------
// Orchestrated Preflight Runner
// ---------------------------------------------------------------------------

/**
 * Runs complete preflight validation and delivery forecast.
 *
 * Invariant: 100% read-only.
 */
export async function runPreflight(
  input: RunPreflightInput,
  dbClient: Pool | Client = db,
  redisClient: Redis = defaultRedis
): Promise<PreflightResult> {
  const {
    userId,
    senderId,
    campaignId,
    hourlyLimit,
    scheduledAt,
    content,
    recipients,
    maxUploadSizeBytes,
  } = input;

  // 1. Resolve Sender ID
  let effectiveSenderId = senderId;
  if (!effectiveSenderId && campaignId) {
    const campRes = await dbClient.query<CampaignRow>(
      `SELECT sender_id FROM campaigns WHERE id = $1 AND user_id = $2`,
      [campaignId, userId]
    );
    if (campRes.rows.length > 0 && campRes.rows[0]!.sender_id) {
      effectiveSenderId = campRes.rows[0]!.sender_id;
    }
  }

  if (!effectiveSenderId) {
    throw new Error('sender_id is required for preflight capacity and forecast calculation');
  }

  // 2. Recipient Validation Engine
  const validation = await validateRecipients(
    {
      userId,
      campaignId,
      rawContent: content,
      recipients,
      maxUploadSizeBytes,
    },
    dbClient
  );

  // 3. Sender Capacity & Forecast Engine
  const effectiveRecipientCount =
    input.recipientCount !== undefined && input.recipientCount >= 0
      ? input.recipientCount
      : validation.counts.valid_count;

  const { capacity, forecast, whatIfScenario } = await calculateCapacityAndForecast(
    {
      userId,
      senderId: effectiveSenderId,
      campaignId,
      hourlyLimit,
      scheduledAt,
      recipientCount: effectiveRecipientCount,
    },
    dbClient,
    redisClient
  );

  return {
    success: validation.errors.length === 0,
    validation,
    capacity,
    forecast,
    what_if_scenario: whatIfScenario || null,
  };
}
