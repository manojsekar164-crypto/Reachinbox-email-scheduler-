/**
 * src/workers/boundedWorker.ts
 *
 * ReachInbox Safe Bounded Cloud Email Worker.
 *
 * Designed for serverless and ephemeral compute platforms (GitHub Actions,
 * Cloud Run Jobs, Render cron, AWS ECS tasks) to eliminate continuous local worker dependency.
 *
 * Key guarantees:
 *  1. One-Shot Bounded Execution:
 *     - Runs for a strictly bounded processing window (default: 4 minutes / 240s).
 *     - Exits cleanly after an idle quiet period once the queue is drained (default: 15s).
 *  2. Concurrency Protection (Distributed Mutex):
 *     - Acquires an atomic Redis lock (`reachinbox:worker:bounded-lock`) via SET NX PX.
 *     - Exits cleanly (code 0) without conflicting if another worker holds the lock.
 *     - Renews lock TTL periodically while actively processing.
 *     - Releases lock safely on exit via Lua atomic compare-and-delete.
 *  3. Canonical Processing Integrity:
 *     - Reuses canonical `processEmailJob(job, db)` from `emailWorker.ts`.
 *     - Preserves all delivery state machines, idempotency, rate limiting, and spacing.
 *  4. Transactional Outbox & Stale Delivery Reconciliation:
 *     - Reconciles stale in-flight deliveries at startup and shutdown.
 *     - Dispatches due outbox records into BullMQ before and during the loop.
 *  5. Graceful Shutdown & Signal Handling:
 *     - Catches SIGINT/SIGTERM, stops accepting new jobs, awaits in-flight jobs,
 *       releases locks, disconnects DB/Redis, and exits safely.
 *  6. Exit Code Semantics:
 *     - Exits with 0 on clean bounded completion, queue drain, or lock contention.
 *     - Exits with 1 on genuine fatal connection or runtime errors.
 */

import { Worker, Job, Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { db as pool, connectDB, disconnectDB } from '../db/postgres';
import { redis, connectRedis, disconnectRedis } from '../db/redis';
import {
  emailQueueName,
  emailQueue,
  EmailJobPayload,
  redisConnectionOptions,
} from '../queue/emailQueue';
import { processEmailJob } from './emailWorker';
import { reconcileStaleDeliveries } from '../services/deliveryService';
import { processOutboxBatch, reconcileScheduledDeliveries } from '../services/outboxPublisher';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Configuration & Types
// ---------------------------------------------------------------------------

export interface BoundedWorkerOptions {
  maxDurationMs?: number;
  idleTimeoutMs?: number;
  pollIntervalMs?: number;
  lockKey?: string;
  lockTtlMs?: number;
  concurrency?: number;
  queueName?: string;
  queue?: Queue<EmailJobPayload>;
  redisOptions?: any;
}

export interface BoundedWorkerResult {
  status: 'completed' | 'timeout' | 'lock_contention' | 'error';
  processedCount: number;
  failedCount: number;
  durationMs: number;
  reconciledStaleCount: number;
  dispatchedOutboxCount: number;
}

let activeWorkerInstance: Worker<EmailJobPayload, void, string> | null = null;
let activeInstanceId: string | null = null;
let activeLockKey: string = 'reachinbox:worker:bounded-lock';
let isShuttingDown = false;

// ---------------------------------------------------------------------------
// Lock Release Helper (Atomic Lua Script)
// ---------------------------------------------------------------------------

async function releaseDistributedLock(key: string, instanceId: string): Promise<boolean> {
  try {
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const res = await redis.eval(luaScript, 1, key, instanceId);
    return res === 1;
  } catch (err: any) {
    console.warn(`⚠️ [BoundedWorker] Failed to release distributed lock: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core Bounded Worker Execution
// ---------------------------------------------------------------------------

export async function runBoundedWorker(
  options: BoundedWorkerOptions = {},
  dbClient: Pool = pool
): Promise<BoundedWorkerResult> {
  const startTime = Date.now();
  const rawMaxMs = process.env['WORKER_MAX_DURATION_MS'] || (process.env['WORKER_MAX_DURATION_SECONDS'] ? String(parseInt(process.env['WORKER_MAX_DURATION_SECONDS']!, 10) * 1000) : '240000');
  const rawIdleMs = process.env['WORKER_IDLE_TIMEOUT_MS'] || (process.env['WORKER_IDLE_TIMEOUT_SECONDS'] ? String(parseInt(process.env['WORKER_IDLE_TIMEOUT_SECONDS']!, 10) * 1000) : '15000');
  const maxDurationMs = options.maxDurationMs ?? parseInt(rawMaxMs, 10);
  const idleTimeoutMs = options.idleTimeoutMs ?? parseInt(rawIdleMs, 10);
  const pollIntervalMs = options.pollIntervalMs ?? parseInt(process.env['WORKER_POLL_INTERVAL_MS'] || '2000', 10);
  const concurrency = options.concurrency ?? parseInt(process.env['WORKER_CONCURRENCY'] || String(config.app.workerConcurrency || 2), 10);
  const lockKey = options.lockKey ?? (process.env['WORKER_LOCK_KEY'] || 'reachinbox:worker:bounded-lock');
  const lockTtlMs = options.lockTtlMs ?? (maxDurationMs + 30000);
  const targetQueueName = options.queueName || emailQueueName;
  const targetRedisOptions = options.redisOptions || redisConnectionOptions;
  const ownQueueCreated = !options.queue && options.queueName !== undefined && options.queueName !== emailQueueName;
  const queueToUse = options.queue || (ownQueueCreated
    ? new Queue<EmailJobPayload>(targetQueueName, { connection: targetRedisOptions })
    : emailQueue);

  const instanceId = randomUUID();
  activeInstanceId = instanceId;
  activeLockKey = lockKey;

  let lockAcquired = false;
  let activeJobs = 0;
  let processedCount = 0;
  let failedCount = 0;
  let lastActivityTimestamp = Date.now();
  let totalDispatchedOutbox = 0;
  let totalStaleReconciled = 0;

  console.log('\n======================================================================');
  console.log('  REACHINBOX BOUNDED CLOUD EMAIL WORKER');
  console.log(`  Instance ID:    ${instanceId}`);
  console.log(`  Max Duration:   ${Math.round(maxDurationMs / 1000)}s`);
  console.log(`  Idle Timeout:   ${Math.round(idleTimeoutMs / 1000)}s`);
  console.log(`  Concurrency:    ${concurrency}`);
  console.log(`  Queue Name:     ${targetQueueName}`);
  console.log('======================================================================\n');

  try {
    // 1. Connection Readiness Verification
    console.log('1. Verifying database & Redis connection readiness...');
    const testConn = await dbClient.connect();
    testConn.release();
    await connectRedis();
    console.log('   ✅ Database & Redis connections active.\n');

    // 2. Concurrency Protection (Atomic Mutex Lock)
    console.log('2. Acquiring distributed execution lock...');
    const lockResult = await redis.set(lockKey, instanceId, 'PX', lockTtlMs, 'NX');
    if (lockResult !== 'OK') {
      console.log('⚠️ [BoundedWorker] Another cloud worker instance is currently holding the execution lock.');
      console.log('   Exiting cleanly (0) to preserve non-overlapping execution.\n');
      return {
        status: 'lock_contention',
        processedCount: 0,
        failedCount: 0,
        durationMs: Date.now() - startTime,
        reconciledStaleCount: 0,
        dispatchedOutboxCount: 0,
      };
    }
    lockAcquired = true;
    console.log(`   ✅ Lock acquired: "${lockKey}" (TTL: ${Math.round(lockTtlMs / 1000)}s)\n`);

    // 3. Startup Reconciliations
    console.log('3. Running startup reconciliations...');
    const staleResult = await reconcileStaleDeliveries(dbClient);
    totalStaleReconciled = staleResult.reconciledCount;
    if (totalStaleReconciled > 0) {
      console.log(`   ⚠️ Reconciled ${totalStaleReconciled} stale in-flight deliveries.`);
    } else {
      console.log('   ✅ Startup stale check complete (0 stale deliveries).');
    }

    // Reconcile scheduled deliveries & dispatch outbox items
    const schedResult = await reconcileScheduledDeliveries(dbClient, queueToUse);
    const outboxResult = await processOutboxBatch(50, `bounded_${instanceId}`, 30000, dbClient, queueToUse);
    totalDispatchedOutbox = outboxResult.dispatched;
    console.log(`   📦 Outbox: dispatched ${outboxResult.dispatched} items to BullMQ (${schedResult.enqueued} scheduled recovered).\n`);

    // 4. Initialize BullMQ Worker
    console.log('4. Initializing bounded BullMQ worker...');
    activeWorkerInstance = new Worker<EmailJobPayload, void, string>(
      targetQueueName,
      async (job: Job<EmailJobPayload>) => {
        activeJobs++;
        lastActivityTimestamp = Date.now();
        try {
          await processEmailJob(job, dbClient);
          processedCount++;
        } catch (jobErr) {
          failedCount++;
          throw jobErr;
        } finally {
          activeJobs--;
          lastActivityTimestamp = Date.now();
        }
      },
      {
        connection: targetRedisOptions,
        concurrency,
        autorun: false,
      }
    );

    activeWorkerInstance.on('completed', (job) => {
      console.log(`🟢 [Job ${job.id}] Successfully completed.`);
    });

    activeWorkerInstance.on('failed', (job, err) => {
      console.error(`🔴 [Job ${job?.id}] Failed: ${err.message}`);
    });

    activeWorkerInstance.on('error', (err) => {
      console.error(`❌ [BoundedWorker] BullMQ worker error: ${err.message}`);
    });

    activeWorkerInstance.run();
    console.log('   👷 BullMQ worker active and processing jobs.\n');

    // 5. Bounded Polling Loop
    let exitReason = 'duration_exceeded';
    while (Date.now() - startTime < maxDurationMs && !isShuttingDown) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      if (isShuttingDown) break;

      // Check for newly arrived outbox events during this run
      try {
        const batchRes = await processOutboxBatch(50, `bounded_${instanceId}`, 30000, dbClient, queueToUse);
        if (batchRes.dispatched > 0) {
          totalDispatchedOutbox += batchRes.dispatched;
          lastActivityTimestamp = Date.now();
        }
      } catch (err: any) {
        console.warn(`⚠️ [OutboxPolling] Error: ${err.message}`);
      }

      // Query BullMQ counts
      const counts = await queueToUse.getJobCounts('waiting', 'active', 'delayed');

      // Renew distributed lock TTL
      if (lockAcquired) {
        await redis.pexpire(lockKey, lockTtlMs);
      }

      // Check drain & idle exit condition
      if (counts.waiting === 0 && counts.active === 0 && activeJobs === 0) {
        const idleElapsed = Date.now() - lastActivityTimestamp;
        if (idleElapsed >= idleTimeoutMs) {
          exitReason = `queue_drained_and_idle (${Math.round(idleElapsed / 1000)}s idle)`;
          break;
        }
      }
    }

    console.log(`\n5. Bounded processing window finished: ${exitReason}`);
    console.log(`   Jobs processed: ${processedCount}, Failed: ${failedCount}, Outbox dispatched: ${totalDispatchedOutbox}`);

    // 6. Graceful Worker Shutdown
    if (activeWorkerInstance) {
      console.log('   Stopping BullMQ worker and awaiting in-flight jobs...');
      await activeWorkerInstance.close();
      activeWorkerInstance = null;
      console.log('   ✅ Worker stopped cleanly.');
    }

    // Final sweep of stale deliveries
    const finalStale = await reconcileStaleDeliveries(dbClient);
    if (finalStale.reconciledCount > 0) {
      totalStaleReconciled += finalStale.reconciledCount;
    }

    // Release distributed lock
    if (lockAcquired) {
      await releaseDistributedLock(lockKey, instanceId);
      lockAcquired = false;
    }

    if (ownQueueCreated) {
      try {
        await queueToUse.close();
      } catch (_) {}
    }

    return {
      status: 'completed',
      processedCount,
      failedCount,
      durationMs: Date.now() - startTime,
      reconciledStaleCount: totalStaleReconciled,
      dispatchedOutboxCount: totalDispatchedOutbox,
    };
  } catch (err: any) {
    console.error('❌ [BoundedWorker] Fatal execution failure:', err);
    if (lockAcquired) {
      await releaseDistributedLock(lockKey, instanceId);
    }
    if (activeWorkerInstance) {
      try {
        await activeWorkerInstance.close();
      } catch (_) {}
      activeWorkerInstance = null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Graceful Signal Handling (SIGINT, SIGTERM)
// ---------------------------------------------------------------------------

async function handleSignal(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n⚠️  [BoundedWorker] Received ${signal}. Initiating safe graceful shutdown...`);

  if (activeWorkerInstance) {
    try {
      await activeWorkerInstance.close();
      activeWorkerInstance = null;
      console.log('   ✅ Active jobs completed, worker stopped.');
    } catch (err: any) {
      console.warn(`⚠️ [BoundedWorker] Error closing worker on ${signal}: ${err.message}`);
    }
  }

  if (activeInstanceId) {
    await releaseDistributedLock(activeLockKey, activeInstanceId);
  }

  try {
    await disconnectRedis();
    await disconnectDB();
  } catch (_) {}

  console.log('👋 [BoundedWorker] Shutdown complete.');
  process.exit(0);
}

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

// ---------------------------------------------------------------------------
// CLI Execution Entry Point
// ---------------------------------------------------------------------------

if (require.main === module) {
  runBoundedWorker()
    .then(async (result) => {
      console.log(`\n🏁 [BoundedWorker] Completed with status: "${result.status}" (${result.durationMs}ms)`);
      try {
        await disconnectRedis();
        await disconnectDB();
      } catch (_) {}
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('💥 [BoundedWorker] Exiting with code 1 due to fatal error:', err);
      try {
        await disconnectRedis();
        await disconnectDB();
      } catch (_) {}
      process.exit(1);
    });
}
