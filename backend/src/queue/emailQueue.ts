import { Queue, DefaultJobOptions } from 'bullmq';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Typed Job Payload
// ---------------------------------------------------------------------------
export interface EmailJobPayload {
  campaignId: string;
  recipientId: string;
}

// ---------------------------------------------------------------------------
// Queue Configuration
// ---------------------------------------------------------------------------

// BullMQ requires maxRetriesPerRequest to be null for its Redis connections.
// We use the existing host and port from config.
export const redisConnectionOptions = {
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
  removeOnComplete: true,      // Automatically remove successful jobs to save memory
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
