import { redis } from '../db/redis';

const RATE_LIMIT_LUA = `
  local key = KEYS[1]
  local limit = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])

  local current = tonumber(redis.call("GET", key) or "0")
  if current >= limit then
    local ttl = redis.call("PTTL", key)
    if ttl < 0 then 
      -- If no expiration is set, or key doesn't exist, wait full window
      return {0, window * 1000}
    end
    return {0, ttl}
  else
    redis.call("INCR", key)
    if current == 0 then
      -- Set expiration only on the first increment to create the fixed window
      redis.call("EXPIRE", key, window)
    end
    return {1, 0}
  end
`;

/**
 * Atomically checks and increments a rate limit key in Redis.
 */
async function checkKeyRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; waitMs: number }> {
  // If limit <= 0, rate limiting is disabled for this key
  if (limit <= 0) {
    return { allowed: true, waitMs: 0 };
  }

  const result = (await redis.eval(
    RATE_LIMIT_LUA,
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

/**
 * Atomically checks and increments the rate limit for a given campaign.
 * Uses a Redis Lua script to guarantee concurrency safety.
 *
 * @param campaignId The campaign to limit
 * @param limit The maximum number of successful sends allowed in the window
 * @param windowSeconds The size of the rolling window in seconds
 * @returns { allowed: boolean, waitMs: number }
 */
export async function checkRateLimit(
  campaignId: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; waitMs: number }> {
  const key = `rate-limit:campaign:${campaignId}`;
  return checkKeyRateLimit(key, limit, windowSeconds);
}

/**
 * Atomically checks and increments the shared rate limit for a specific SMTP sender.
 * Enforces shared rate limits across multiple campaigns using the same sender.
 *
 * @param senderId The sender to limit
 * @param limit The maximum number of sends allowed in the window for this sender
 * @param windowSeconds The size of the rolling window in seconds
 * @returns { allowed: boolean, waitMs: number }
 */
export async function checkSenderRateLimit(
  senderId: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; waitMs: number }> {
  const key = `rate-limit:sender:${senderId}`;
  return checkKeyRateLimit(key, limit, windowSeconds);
}
