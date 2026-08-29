import { Pool, PoolConfig } from 'pg';
import { config } from '../config';

const poolConfig: PoolConfig = {
  connectionString: config.db.url,
  // Keep a small, sensible pool for Phase 1
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
};

export const db = new Pool(poolConfig);

/**
 * Verify the database connection.
 * Called once during server startup.
 */
export async function connectDB(): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('SELECT 1');
    console.log('✅  PostgreSQL connected');
  } finally {
    client.release();
  }
}

/**
 * Gracefully close the database pool.
 * Called on process shutdown.
 */
export async function disconnectDB(): Promise<void> {
  await db.end();
  console.log('🔌  PostgreSQL disconnected');
}
