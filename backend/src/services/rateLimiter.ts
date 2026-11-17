/**
 * src/services/rateLimiter.ts
 *
 * Distributed Rate Limiting & Minimum Send Spacing Coordination.
 *
 * Implements an atomic Redis Lua-based reservation mechanism coordinating:
 *  1. Minimum send spacing across concurrent workers
 *  2. Global hourly limit (GLOBAL_EMAILS_PER_HOUR)
 *  3. Campaign-specific hourly limits
 *  4. Sender-specific shared hourly limits
 *
 * Invariants:
 *  - Atomic check of ALL applicable limits BEFORE consuming any quota.
 *  - Zero partial quota consumption if any limit blocks.
 *  - Uses Redis server time (redis.call('TIME')) for consistent distributed timing.
 *  - Global limit of zero disables the global cap.
 */

import { redis } from '../db/redis';
import { config } from '../config';

export type RateLimitReason = 'spacing' | 'global' | 'campaign' | 'sender';

export interface ReserveSendSlotOptions {
  campaignId: string;
  campaignLimit?: number | null;
  senderId?: string | null;
  senderLimit?: number | null;
  globalLimit?: number | null;
  windowSeconds?: number;
  sendDelayMs?: number;
}

export interface RateLimitReservationResult {
  allowed: boolean;
  waitMs: number;
  reason?: RateLimitReason | null;
  slotTime: number;
}

/**
 * Returns the effective global hourly limit from environment or configuration.
 * A limit <= 0 disables the global cap.
 */
export function getGlobalHourlyLimit(): number {
  const envVal = process.env['GLOBAL_EMAILS_PER_HOUR'];
  if (envVal !== undefined && envVal !== '') {
    const parsed = parseInt(envVal, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  }
  return config.app.globalHourlyLimit || 0;
}

/**
 * Unified Atomic Rate Limiting & Send Spacing Lua Script.
 *
 * KEYS[1]: Spacing key ('email-send:global:last-send')
 * KEYS[2]: Global rate limit key ('rate-limit:global')
 * KEYS[3]: Campaign rate limit key ('rate-limit:campaign:<campaignId>')
 * KEYS[4]: Sender rate limit key ('rate-limit:sender:<senderId>')
 *
 * ARGV[1]: delayMs (0 if disabled)
 * ARGV[2]: globalLimit (0 if disabled)
 * ARGV[3]: campaignLimit (0 if disabled)
 * ARGV[4]: senderLimit (0 if disabled)
 * ARGV[5]: windowSeconds (e.g. 3600)
 */
const UNIFIED_RATE_LIMIT_LUA = `
  local spacingKey = KEYS[1]
  local globalKey = KEYS[2]
  local campaignKey = KEYS[3]
  local senderKey = KEYS[4]

  local delayMs = tonumber(ARGV[1] or '0')
  local globalLimit = tonumber(ARGV[2] or '0')
  local campaignLimit = tonumber(ARGV[3] or '0')
  local senderLimit = tonumber(ARGV[4] or '0')
  local windowSeconds = tonumber(ARGV[5] or '3600')

  -- Distributed Redis Server Time
  local t = redis.call('TIME')
  local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

  -- 1. Check Minimum Send Spacing
  if delayMs > 0 then
    local last_send = tonumber(redis.call('GET', spacingKey) or '0')
    if last_send > 0 and (now_ms - last_send) < delayMs then
      local wait_ms = (last_send + delayMs) - now_ms
      return {0, wait_ms, 'spacing', now_ms}
    end
  end

  -- 2. Check Global Hourly Limit
  local current_global = 0
  if globalLimit > 0 then
    current_global = tonumber(redis.call('GET', globalKey) or '0')
    if current_global >= globalLimit then
      local ttl = redis.call('PTTL', globalKey)
      if ttl < 0 then ttl = windowSeconds * 1000 end
      return {0, ttl, 'global', now_ms}
    end
  end

  -- 3. Check Campaign Hourly Limit
  local current_campaign = 0
  if campaignLimit > 0 then
    current_campaign = tonumber(redis.call('GET', campaignKey) or '0')
    if current_campaign >= campaignLimit then
      local ttl = redis.call('PTTL', campaignKey)
      if ttl < 0 then ttl = windowSeconds * 1000 end
      return {0, ttl, 'campaign', now_ms}
    end
  end

  -- 4. Check Sender Hourly Limit
  local current_sender = 0
  if senderLimit > 0 and senderKey ~= '' and senderKey ~= 'rate-limit:sender:none' then
    current_sender = tonumber(redis.call('GET', senderKey) or '0')
    if current_sender >= senderLimit then
      local ttl = redis.call('PTTL', senderKey)
      if ttl < 0 then ttl = windowSeconds * 1000 end
      return {0, ttl, 'sender', now_ms}
    end
  end

  -- ALL CHECKS PASSED: Atomically consume quota for all active limits
  if delayMs > 0 then
    redis.call('SET', spacingKey, tostring(now_ms), 'EX', 3600)
  end

  if globalLimit > 0 then
    redis.call('INCR', globalKey)
    if current_global == 0 then
      redis.call('EXPIRE', globalKey, windowSeconds)
    end
  end

  if campaignLimit > 0 then
    redis.call('INCR', campaignKey)
    if current_campaign == 0 then
      redis.call('EXPIRE', campaignKey, windowSeconds)
    end
  end

  if senderLimit > 0 and senderKey ~= '' and senderKey ~= 'rate-limit:sender:none' then
    redis.call('INCR', senderKey)
    if current_sender == 0 then
      redis.call('EXPIRE', senderKey, windowSeconds)
    end
  end

  return {1, 0, 'ok', now_ms}
`;

/**
 * Atomically checks and reserves a send slot across all applicable limits:
 * global limit, campaign limit, sender limit, and minimum send spacing.
 */
export async function reserveSendSlot(
  options: ReserveSendSlotOptions
): Promise<RateLimitReservationResult> {
  const {
    campaignId,
    campaignLimit = 0,
    senderId = null,
    senderLimit = 0,
    globalLimit = 0,
    windowSeconds = config.app.rateLimitWindow,
    sendDelayMs = 0,
  } = options;

  const spacingKey = 'email-send:global:last-send';
  const globalKey = 'rate-limit:global';
  const campaignKey = `rate-limit:campaign:${campaignId}`;
  const senderKey = senderId ? `rate-limit:sender:${senderId}` : 'rate-limit:sender:none';

  const result = (await redis.eval(
    UNIFIED_RATE_LIMIT_LUA,
    4,
    spacingKey,
    globalKey,
    campaignKey,
    senderKey,
    sendDelayMs || 0,
    globalLimit || 0,
    campaignLimit || 0,
    senderLimit || 0,
    windowSeconds || 3600
  )) as [number, number, string, number];

  const allowed = result[0] === 1;
  const waitMs = Number(result[1]);
  const reasonStr = result[2];
  const slotTime = Number(result[3]);

  return {
    allowed,
    waitMs,
    reason: allowed ? null : (reasonStr as RateLimitReason),
    slotTime,
  };
}

// ---------------------------------------------------------------------------
// Backward-Compatible Individual Rate Limiting Helpers
// ---------------------------------------------------------------------------

const SINGLE_KEY_RATE_LIMIT_LUA = `
  local key = KEYS[1]
  local limit = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])

  local current = tonumber(redis.call("GET", key) or "0")
  if current >= limit then
    local ttl = redis.call("PTTL", key)
    if ttl < 0 then 
      return {0, window * 1000}
    end
    return {0, ttl}
  else
    redis.call("INCR", key)
    if current == 0 then
      redis.call("EXPIRE", key, window)
    end
    return {1, 0}
  end
`;

async function checkKeyRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; waitMs: number }> {
  if (limit <= 0) {
    return { allowed: true, waitMs: 0 };
  }

  const result = (await redis.eval(
    SINGLE_KEY_RATE_LIMIT_LUA,
    1,
    key,
    limit,
    windowSeconds
  )) as [number, number];

  return {
    allowed: result[0] === 1,
    waitMs: result[1],
  };
}

export async function checkRateLimit(
  campaignId: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; waitMs: number }> {
  const key = `rate-limit:campaign:${campaignId}`;
  return checkKeyRateLimit(key, limit, windowSeconds);
}

export async function checkSenderRateLimit(
  senderId: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; waitMs: number }> {
  const key = `rate-limit:sender:${senderId}`;
  return checkKeyRateLimit(key, limit, windowSeconds);
}

export async function checkGlobalRateLimit(
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; waitMs: number }> {
  const key = 'rate-limit:global';
  return checkKeyRateLimit(key, limit, windowSeconds);
}
