import crypto from 'crypto';

const KEY_VERSION = 'enc:v1';
const IV_LENGTH = 12; // 12 bytes standard for AES-256-GCM
const CIPHER_ALGORITHM = 'aes-256-gcm';

/**
 * Resolves and validates the 32-byte encryption key from environment.
 * Fails closed in production if ENCRYPTION_KEY is missing or invalid.
 */
export function getDerivedEncryptionKey(): Buffer {
  const rawKey = process.env['ENCRYPTION_KEY'];
  const isProd = process.env['NODE_ENV'] === 'production';

  if (!rawKey || rawKey.trim() === '') {
    if (isProd) {
      throw new Error(
        'CRITICAL SECURITY CONFIGURATION ERROR: ENCRYPTION_KEY environment variable is required in production! ' +
        'Refusing to run with missing or default encryption key.'
      );
    }
    // Secure fallback deterministic key for local development and test environments only
    return crypto.createHash('sha256').update('reachinbox-dev-local-encryption-key-32b').digest();
  }

  // 64 hex characters = 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }

  // 44 base64 characters = 32 bytes
  if (/^[A-Za-z0-9+/]{43}=$/.test(rawKey)) {
    return Buffer.from(rawKey, 'base64');
  }

  // Passphrase with minimum 32 characters
  if (rawKey.length >= 32) {
    return crypto.createHash('sha256').update(rawKey, 'utf8').digest();
  }

  if (isProd) {
    throw new Error(
      'CRITICAL SECURITY CONFIGURATION ERROR: ENCRYPTION_KEY must be at least 32 characters (or 64 hex characters).'
    );
  }

  return crypto.createHash('sha256').update(rawKey, 'utf8').digest();
}

/**
 * Determines whether a given string is encrypted with versioned AES-256-GCM.
 * Format: enc:v1:<iv_hex_24>:<auth_tag_hex_32>:<cipher_hex>
 */
export function isEncrypted(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  if (text.startsWith(`${KEY_VERSION}:`)) {
    const parts = text.split(':');
    return parts.length === 5 && parts[2]?.length === 24 && parts[3]?.length === 32 && (parts[4]?.length ?? 0) > 0;
  }
  return false;
}

/**
 * Encrypts a string using authenticated AES-256-GCM.
 * Format: enc:v1:<iv_hex>:<auth_tag_hex>:<cipher_hex>
 */
export function encrypt(text: string): string {
  if (!text) return text;
  if (isEncrypted(text)) return text; // Idempotent

  const key = getDerivedEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');
  return `${KEY_VERSION}:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts a versioned AES-256-GCM string.
 * Supports transparent fallback for legacy plaintext credentials.
 */
export function decrypt(encryptedText: string): string {
  if (!encryptedText) return encryptedText;

  // If not encrypted, return as is (transparent backward compatibility)
  if (!isEncrypted(encryptedText)) {
    // Check legacy 3-part unversioned format (iv:authTag:cipher)
    const legacyParts = encryptedText.split(':');
    if (legacyParts.length === 3 && legacyParts[0]!.length === 24 && legacyParts[1]!.length === 32) {
      try {
        const key = getDerivedEncryptionKey();
        const iv = Buffer.from(legacyParts[0]!, 'hex');
        const authTag = Buffer.from(legacyParts[1]!, 'hex');
        const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        let dec = decipher.update(legacyParts[2]!, 'hex', 'utf8');
        dec += decipher.final('utf8');
        return dec;
      } catch {
        return encryptedText;
      }
    }
    return encryptedText;
  }

  const parts = encryptedText.split(':');
  const iv = Buffer.from(parts[2]!, 'hex');
  const authTag = Buffer.from(parts[3]!, 'hex');
  const cipherHex = parts[4]!;

  const key = getDerivedEncryptionKey();
  const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Safe encryption wrapper that guarantees idempotency.
 */
export function safeEncrypt(text: string): string {
  return encrypt(text);
}

/**
 * Safe decryption wrapper that returns original text if not encrypted,
 * and decrypts authenticated AES-256-GCM data (throwing if corrupted or tampered).
 */
export function safeDecrypt(text: string): string {
  if (!text || !isEncrypted(text)) {
    return text;
  }
  return decrypt(text);
}
