import { Pool, PoolConfig } from 'pg';
import { config } from '../config';

const isSslRequired = Boolean(
  process.env['DATABASE_URL']?.includes('render.com') ||
  process.env['DATABASE_URL']?.includes('neon.tech') ||
  process.env['DATABASE_URL']?.includes('sslmode=require') ||
  process.env['DATABASE_URL']?.includes('ssl=true') ||
  process.env['NODE_ENV'] === 'production'
);

const poolConfig: PoolConfig = {
  connectionString: config.db.url,
  // Keep a small, sensible pool for Phase 1
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: isSslRequired ? { rejectUnauthorized: true } : undefined,
};

export const db = new Pool(poolConfig);
export const pool = db;

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
