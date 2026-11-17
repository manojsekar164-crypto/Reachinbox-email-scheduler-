/**
 * src/db/migrate.ts
 *
 * Production-grade migration engine with:
 *  - schema_migrations version and SHA-256 checksum tracking.
 *  - PostgreSQL advisory lock serialization (prevents race conditions).
 *  - Transactional migration execution with rollback on failure.
 *  - Safe bootstrap for pre-existing legacy schemas (001-003).
 *  - Strict detection and rejection of tampered/modified previously applied migrations.
 *  - Inconsistent schema detection and fail-closed safety.
 *
 * Run with:  npm run db:migrate
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { db, connectDB, disconnectDB } from './postgres';
import { PoolClient } from 'pg';

const ADVISORY_LOCK_ID = 7142981; // Unique 32-bit integer for ReachInbox migrations
const LEGACY_TABLES = [
  'users',
  'campaigns',
  'recipients',
  'email_logs',
  'senders',
  'slack_integrations',
];

export function calculateChecksum(content: string): string {
  // Normalize Windows CRLF to LF so checksums are deterministic across OS platforms
  const normalized = content.replace(/\r\n/g, '\n').trim();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function getMigrationsDirectory(): string {
  let migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    migrationsDir = path.join(process.cwd(), 'src', 'db', 'migrations');
  }
  if (!fs.existsSync(migrationsDir)) {
    migrationsDir = path.join(process.cwd(), 'dist', 'db', 'migrations');
  }
  return migrationsDir;
}

export async function runMigrations(customClient?: PoolClient): Promise<{ applied: string[]; skipped: string[] }> {
  console.log('🔄  Starting database migration runner…');

  const client = customClient ?? (await db.connect());
  const isDedicatedClient = !customClient;
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    // 1. Acquire PostgreSQL session advisory lock to serialize concurrent migrations
    console.log('🔒  Acquiring PostgreSQL advisory lock…');
    await client.query('SELECT pg_advisory_lock($1);', [ADVISORY_LOCK_ID]);
    console.log('✅  Advisory lock acquired.');

    // 2. Ensure schema_migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    VARCHAR      PRIMARY KEY,
        checksum    VARCHAR(64)  NOT NULL,
        applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);

    // 3. Query existing applied migrations
    const { rows: appliedRows } = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations ORDER BY filename ASC;'
    );
    const appliedMap = new Map<string, string>(
      appliedRows.map((r) => [r.filename, r.checksum])
    );

    const migrationsDir = getMigrationsDirectory();
    if (!fs.existsSync(migrationsDir)) {
      throw new Error(`Migrations directory not found at: ${migrationsDir}`);
    }

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // 4. Safe Bootstrap Strategy for Legacy Databases
    if (appliedMap.size === 0) {
      const { rows: existingTables } = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1);`,
        [LEGACY_TABLES]
      );
      const foundTableNames = new Set(existingTables.map((t) => t.table_name));

      if (foundTableNames.size === 0) {
        console.log('🌱  Fresh database detected. Proceeding with clean migration execution.');
      } else if (foundTableNames.size === LEGACY_TABLES.length) {
        console.log('🛡️  Existing complete legacy schema detected (tables 001-003 present).');
        console.log('   Bootstrapping tracking table with baseline migration checksums...');
        const legacyFiles = [
          '001_initial_schema.sql',
          '002_add_senders.sql',
          '003_add_slack_integrations.sql',
        ];

        for (const legacyFile of legacyFiles) {
          const legacyPath = path.join(migrationsDir, legacyFile);
          if (fs.existsSync(legacyPath)) {
            const sql = fs.readFileSync(legacyPath, 'utf-8');
            const checksum = calculateChecksum(sql);
            await client.query(
              `INSERT INTO schema_migrations (filename, checksum, applied_at)
               VALUES ($1, $2, NOW())
               ON CONFLICT (filename) DO NOTHING;`,
              [legacyFile, checksum]
            );
            appliedMap.set(legacyFile, checksum);
            console.log(`   ✅ Marked baseline migration: ${legacyFile} [${checksum.slice(0, 8)}]`);
          }
        }
      } else {
        const found = Array.from(foundTableNames);
        const missing = LEGACY_TABLES.filter((t) => !foundTableNames.has(t));
        throw new Error(
          `Inconsistent partial database schema detected! Found: [${found.join(', ')}], Missing: [${missing.join(', ')}]. ` +
          `Expected either a fresh database or all 6 legacy tables. Halting migration to protect data integrity.`
        );
      }
    }

    // 5. Sequential Transactional Migration Execution
    for (const file of migrationFiles) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');
      const currentChecksum = calculateChecksum(sql);

      if (appliedMap.has(file)) {
        const storedChecksum = appliedMap.get(file);
        if (!storedChecksum || storedChecksum.trim() === '') {
          throw new Error(
            `Security invariant violation: Migration "${file}" is recorded in schema_migrations with an empty or missing checksum! ` +
            `Refusing to silently assign checksum without explicit verification. ` +
            `Run controlled baseline procedure to verify migration integrity.`
          );
        }
        if (storedChecksum !== currentChecksum) {
          throw new Error(
            `Migration checksum mismatch for "${file}"!\n` +
            `  Database record: ${storedChecksum}\n` +
            `  Disk file:       ${currentChecksum}\n` +
            `Applied migrations are immutable. Do not alter previously applied migrations.`
          );
        }
        console.log(`  ⏩  Skipping: ${file} (checksum verified)`);
        skipped.push(file);
        continue;
      }

      console.log(`  ▶  Applying: ${file} [checksum: ${currentChecksum.slice(0, 8)}]`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum, applied_at)
           VALUES ($1, $2, NOW());`,
          [file, currentChecksum]
        );
        await client.query('COMMIT');
        applied.push(file);
        console.log(`  ✅  Done:    ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ❌  Failed:  ${file} (Transaction rolled back)`);
        throw err;
      }
    }

    console.log(`🎉  All migrations processed: ${applied.length} applied, ${skipped.length} skipped.`);
    return { applied, skipped };
  } finally {
    // 6. Always release advisory lock
    try {
      await client.query('SELECT pg_advisory_unlock($1);', [ADVISORY_LOCK_ID]);
      console.log('🔓  Advisory lock released.');
    } catch (unlockErr: any) {
      console.warn('⚠️  Warning during advisory unlock:', unlockErr.message);
    }

    if (isDedicatedClient) {
      client.release();
    }
  }
}

// ─── Direct Execution Entry Point ─────────────────────────────────────────────
if (require.main === module) {
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
}
