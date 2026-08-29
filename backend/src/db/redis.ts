import Redis from 'ioredis';
import { config } from '../config';

export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  // Retry aggressively during startup; back off after 10 attempts
  retryStrategy: (times: number) => {
    if (times > 10) {
      console.error('❌  Redis: max retries reached, giving up');
      return null; // stop retrying
    }
    return Math.min(times * 100, 3_000);
  },
  lazyConnect: true,
});

/**
 * Open the Redis connection and verify with PING.
 * Called once during server startup.
 */
export async function connectRedis(): Promise<void> {
  await redis.connect();
  await redis.ping();
  console.log('✅  Redis connected');
}

/**
 * Gracefully close the Redis connection.
 * Called on process shutdown.
 */
export async function disconnectRedis(): Promise<void> {
  await redis.quit();
  console.log('🔌  Redis disconnected');
}
