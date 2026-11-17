/**
 * src/db/migrate.ts
 *
 * Discovers and executes all pending .sql migration files in sequential order.
 * Tracks applied migrations in the `schema_migrations` table for robust idempotency.
 * Run with:  npm run db:migrate
 */

import path from 'path';
import fs from 'fs';
import { db, connectDB, disconnectDB } from './postgres';

async function runMigrations(): Promise<void> {
  console.log('🔄  Running database migrations…');

  // Ensure tracking table exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR      PRIMARY KEY,
      applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `);

  const { rows } = await db.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations;'
  );
  const appliedMigrations = new Set(rows.map((r) => r.filename));

  let migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    migrationsDir = path.join(process.cwd(), 'src', 'db', 'migrations');
  }
  if (!fs.existsSync(migrationsDir)) {
    migrationsDir = path.join(process.cwd(), 'dist', 'db', 'migrations');
  }

  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    if (appliedMigrations.has(file)) {
      console.log(`  ⏩  Skipping: ${file} (already applied)`);
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    console.log(`  ▶  Applying: ${file}`);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1);',
        [file]
      );
      await client.query('COMMIT');
      console.log(`  ✅  Done:    ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  console.log('🎉  All database migrations processed successfully.');
}

// ─── Entry point ──────────────────────────────────────────────────────────────
(async () => {
  try {
    await connectDB();
    await runMigrations();
  } catch (err) {
    console.error('❌  Migration failed:', err);
    process.exit(1);
  } finally {
    await disconnectDB();
  }
})();
