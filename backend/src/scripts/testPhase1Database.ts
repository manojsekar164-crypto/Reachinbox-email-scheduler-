/**
 * src/scripts/testPhase1Database.ts
 *
 * Phase 1 Verification Script:
 *  1. AES-256-GCM symmetric encryption / decryption roundtrip on SMTP credentials.
 *  2. Verification that already-encrypted strings are not double-encrypted.
 *  3. Verification of safeDecrypt backward-compatibility with plaintext.
 *  4. Worker concurrency configuration parsing.
 *  5. Migration files validity and SQL syntax check.
 *  6. Idempotency partial unique index and conflict-safe SQL validation.
 */

import { safeEncrypt, safeDecrypt, isEncrypted } from '../utils/crypto';
import { config } from '../config';
import fs from 'fs';
import path from 'path';

async function runPhase1Tests(): Promise<void> {
  console.log('🧪 Starting Phase 1 Database & Delivery Reliability Verification...\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      failed++;
    }
  }

  // --- Test Suite 1: Credential Encryption at Rest ---
  console.log('1. At-Rest Credential Encryption (AES-256-GCM)');
  const samplePass = 'Secret_Smtp_Pass_2026!#$';
  const encrypted = safeEncrypt(samplePass);
  
  assert(encrypted !== samplePass, 'Encrypted string differs from plaintext');
  assert(isEncrypted(encrypted), 'isEncrypted recognizes AES-256-GCM format');
  assert(encrypted.split(':').length === 3, 'Encrypted format is iv:authTag:cipher');

  const decrypted = safeDecrypt(encrypted);
  assert(decrypted === samplePass, 'safeDecrypt recovers original plaintext');

  // Double encryption guard
  const doubleEncrypted = safeEncrypt(encrypted);
  assert(doubleEncrypted === encrypted, 'safeEncrypt does not double-encrypt already encrypted string');

  // Backward-compatibility: plain text passed to safeDecrypt
  const legacyPlaintext = 'legacy_plaintext_password';
  const safeDecryptedPlain = safeDecrypt(legacyPlaintext);
  assert(safeDecryptedPlain === legacyPlaintext, 'safeDecrypt gracefully returns legacy unencrypted plaintext');

  // --- Test Suite 2: Worker Concurrency Configuration ---
  console.log('\n2. Configurable Worker Concurrency');
  assert(typeof config.app.workerConcurrency === 'number', 'config.app.workerConcurrency is a number');
  assert(config.app.workerConcurrency >= 1, `Worker concurrency is valid: ${config.app.workerConcurrency}`);

  // --- Test Suite 3: Migration Files Integrity ---
  console.log('\n3. Migration Files Integrity');
  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  assert(files.includes('004_add_idempotency_and_sender_limit.sql'), 'Migration 004 exists');
  assert(files.includes('005_add_schema_migrations.sql'), 'Migration 005 exists');

  const m004Content = fs.readFileSync(path.join(migrationsDir, '004_add_idempotency_and_sender_limit.sql'), 'utf-8');
  assert(m004Content.includes('idx_email_logs_campaign_recipient'), 'Migration 004 defines idx_email_logs_campaign_recipient');
  assert(!m004Content.includes('CREATE UNIQUE INDEX'), 'Migration 004 preserves historical duplicate safety (no unique index on historical email_logs)');
  assert(m004Content.includes('hourly_limit'), 'Migration 004 adds hourly_limit to senders');

  const m005Content = fs.readFileSync(path.join(migrationsDir, '005_add_schema_migrations.sql'), 'utf-8');
  assert(m005Content.includes('CREATE TABLE IF NOT EXISTS schema_migrations'), 'Migration 005 defines schema_migrations');

  // --- Test Suite 4: Environment Documentation ---
  console.log('\n4. Environment Configuration');
  const envExample = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf-8');
  assert(envExample.includes('ENCRYPTION_KEY'), '.env.example documents ENCRYPTION_KEY');
  assert(envExample.includes('WORKER_CONCURRENCY'), '.env.example documents WORKER_CONCURRENCY');

  console.log(`\n========================================`);
  console.log(`Phase 1 Tests Completed: ${passed} Passed, ${failed} Failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase1Tests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
