/**
 * src/scripts/migrateCredentials.ts
 *
 * One-time safe migration script for encrypting existing plaintext sender passwords
 * using AES-256-GCM authenticated encryption at rest (prefix `enc:v1:`).
 *
 * Run with: npm run credentials:migrate
 *
 * Safety guarantees:
 *  - Idempotent: Skips already-encrypted credentials (starting with `enc:v1:`).
 *  - Verifies round-trip decryption before committing each row.
 *  - Runs inside a database transaction; rolls back on any error.
 *  - Does NOT alter any other sender fields.
 */

import { pool, disconnectDB } from '../db/postgres';
import { isEncrypted, safeEncrypt, safeDecrypt } from '../utils/crypto';

const SEP = '='.repeat(60);

async function migrateCredentials(): Promise<void> {
  console.log('\n' + SEP);
  console.log('  ReachInbox - Sender Credential Encryption Migration');
  console.log(SEP + '\n');

  const client = await pool.connect();
  try {
    // Check if senders table exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'senders'
      ) as exists;
    `);

    if (!tableCheck.rows[0]?.exists) {
      console.log('⚠️  Table "senders" does not exist yet. Run migrations first.');
      return;
    }

    console.log('1. Scanning "senders" table for plaintext credentials...');
    const result = await client.query<{ id: string; email: string; smtp_pass: string }>(
      'SELECT id, email, smtp_pass FROM senders'
    );

    const total = result.rows.length;
    console.log(`   Found ${total} sender record(s).\n`);

    if (total === 0) {
      console.log('✅ No sender records to migrate.');
      return;
    }

    let alreadyEncrypted = 0;
    let migrated = 0;
    let failed = 0;

    await client.query('BEGIN');

    for (const sender of result.rows) {
      if (isEncrypted(sender.smtp_pass)) {
        alreadyEncrypted++;
        continue;
      }

      const plaintext = sender.smtp_pass;
      if (!plaintext) {
        // Empty or null password, leave as is or skip
        continue;
      }

      const cipherText = safeEncrypt(plaintext);

      // Verify decryption immediately before updating
      const decrypted = safeDecrypt(cipherText);
      if (decrypted !== plaintext) {
        throw new Error(
          `Decryption verification failed for sender ${sender.id} (${sender.email}). Aborting transaction!`
        );
      }

      await client.query(
        'UPDATE senders SET smtp_pass = $1 WHERE id = $2',
        [cipherText, sender.id]
      );
      migrated++;
    }

    await client.query('COMMIT');

    console.log('2. Migration Results:');
    console.log(`   Total senders     : ${total}`);
    console.log(`   Already encrypted : ${alreadyEncrypted}`);
    console.log(`   Newly encrypted   : ${migrated}`);
    console.log(`   Failed            : ${failed}\n`);
    console.log('✅ Credential migration completed successfully.');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors if connection died
    }
    console.error('\n❌ Credential migration failed:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await disconnectDB();
  }
}

if (require.main === module) {
  migrateCredentials().catch((err) => {
    console.error('Fatal error during credential migration:', err);
    process.exit(1);
  });
}

export { migrateCredentials };
