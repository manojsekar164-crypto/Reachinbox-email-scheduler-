import { redis } from '../db/redis';

/**
 * Checks if the minimum delay since the last email send has elapsed.
 * If yes, atomically updates the last send timestamp to current time.
 * If no, returns the remaining delay in milliseconds.
 *
 * @param delayMs The configured minimum delay in milliseconds
 * @returns { allowed: boolean, waitMs: number }
 */
export async function checkSendSpacing(
  delayMs: number
): Promise<{ allowed: boolean; waitMs: number; slotTime: number }> {
  if (delayMs <= 0) {
    return { allowed: true, waitMs: 0, slotTime: Date.now() };
  }

  const key = 'email-send:global:last-send';
  const now = Date.now();

  const luaScript = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local delay = tonumber(ARGV[2])

    local last_send = tonumber(redis.call('GET', key) or '0')
    if last_send == 0 or now - last_send >= delay then
      redis.call('SET', key, tostring(now), 'EX', 3600)
      return {0, now}
    else
      return {last_send + delay - now, last_send}
    end
  `;

  const result = (await redis.eval(
    luaScript,
    1,
    key,
    now,
    delayMs
  )) as [number, number];

  const remainingDelay = result[0];
  const slotTime = result[1];

  return {
    allowed: remainingDelay === 0,
    waitMs: remainingDelay,
    slotTime,
  };
}
