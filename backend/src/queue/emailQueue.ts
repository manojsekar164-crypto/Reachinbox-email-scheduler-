import { Queue, DefaultJobOptions } from 'bullmq';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Typed Job Payload
// ---------------------------------------------------------------------------
export interface EmailJobPayload {
  campaignId: string;
  recipientId: string;
  deliveryId?: string;
}

// ---------------------------------------------------------------------------
// Queue Configuration
// ---------------------------------------------------------------------------

/**
 * Builds BullMQ-compatible Redis connection options from a URL or host/port config.
 * Handles Upstash rediss:// URLs with strict TLS certificate verification.
 */
export function buildRedisConnectionOptions(customUrl?: string): any {
  const targetUrl = customUrl || config.redis.url;
  if (targetUrl) {
    try {
      const parsed = new URL(targetUrl);
      const isTls = parsed.protocol === 'rediss:';
      return {
        host: parsed.hostname,
        port: parseInt(parsed.port || (isTls ? '6380' : '6379'), 10),
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        tls: isTls
          ? {
              rejectUnauthorized: true,
              servername: parsed.hostname,
            }
          : undefined,
        maxRetriesPerRequest: null,
      };
    } catch {
      return {
        url: targetUrl,
        maxRetriesPerRequest: null,
        tls: targetUrl.startsWith('rediss://') ? { rejectUnauthorized: true } : undefined,
      };
    }
  }

  return {
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: null,
  };
}

// BullMQ requires maxRetriesPerRequest to be null for its Redis connections.
export const redisConnectionOptions: any = buildRedisConnectionOptions();

// Sensible defaults to ensure failing jobs back off and completed jobs do not bloat Redis.
const defaultJobOptions: DefaultJobOptions = {
  attempts: 3,                 // Retry up to 3 times
  backoff: {
    type: 'exponential',
    delay: 5000,               // 5 seconds base delay
  },
  removeOnComplete: {
    count: 1000,               // Retain last 1000 completed jobs for audit & Bull Board
    age: 86400,                // Auto-expire after 24 hours
  },
  removeOnFail: false,         // Keep failed jobs for inspection
};

export const emailQueueName = 'email-queue';

export const emailQueue = new Queue<EmailJobPayload>(emailQueueName, {
  connection: redisConnectionOptions,
  defaultJobOptions,
});

emailQueue.on('error', (err) => {
  console.error(`❌ [${emailQueueName}] Queue error:`, err.message);
});
