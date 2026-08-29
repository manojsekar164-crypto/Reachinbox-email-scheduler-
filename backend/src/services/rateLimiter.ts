import { redis } from '../db/redis';

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

  const luaScript = `
    local key = KEYS[1]
    local limit = tonumber(ARGV[1])
    local window = tonumber(ARGV[2])

    local current = tonumber(redis.call("GET", key) or "0")
    if current >= limit then
      local ttl = redis.call("PTTL", key)
      if ttl < 0 then 
        -- If no expiration is set, or key doesn't exist (edge case if deleted between GET and PTTL), wait full window
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

  // ioredis returns array for Lua script returning tables
  const result = (await redis.eval(
    luaScript,
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
