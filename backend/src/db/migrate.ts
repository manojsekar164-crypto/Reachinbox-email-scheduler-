/**
 * src/db/migrate.ts
 *
 * Reads 001_initial_schema.sql and executes it against PostgreSQL.
 * Run with:  npm run db:migrate
 *
 * The SQL uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS,
 * so the script is safe to execute multiple times without dropping data.
 */

import path from 'path';
import fs from 'fs';
import { db, connectDB, disconnectDB } from './postgres';

async function runMigrations(): Promise<void> {
  console.log('🔄  Running database migrations…');

  const migrationsDir = path.join(__dirname, 'migrations');
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // ensures 001_… runs before 002_…, etc.

  for (const file of migrationFiles) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    console.log(`  ▶  Applying: ${file}`);
    await db.query(sql);
    console.log(`  ✅  Done:    ${file}`);
  }

  console.log('🎉  All migrations applied successfully.');
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
