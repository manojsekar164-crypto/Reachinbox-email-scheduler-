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

// BullMQ requires maxRetriesPerRequest to be null for its Redis connections.
export const redisConnectionOptions: any = config.redis.url
  ? {
      url: config.redis.url,
      maxRetriesPerRequest: null,
      tls: config.redis.url.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
    }
  : {
      host: config.redis.host,
      port: config.redis.port,
      maxRetriesPerRequest: null,
    };

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
