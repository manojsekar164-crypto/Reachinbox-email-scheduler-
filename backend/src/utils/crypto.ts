import crypto from 'crypto';
import { config } from '../config';

const CIPHER_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 12 bytes = 96 bits standard for AES-GCM
const CIPHER_REGEX = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i;

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
    const fallbackSecret = config.session?.secret || 'reachinbox-dev-local-encryption-key-32b';
    return crypto.createHash('sha256').update(fallbackSecret).digest();
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
 * Determines whether a string matches the authenticated AES-256-GCM format.
 * Supports standard format (iv:authTag:cipher) and versioned format (enc:v1:iv:authTag:cipher).
 */
export function isEncrypted(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  if (CIPHER_REGEX.test(text)) {
    return true;
  }
  if (text.startsWith('enc:v1:')) {
    const parts = text.split(':');
    return parts.length === 5 && parts[2]?.length === 24 && parts[3]?.length === 32 && (parts[4]?.length ?? 0) > 0;
  }
  return false;
}

/**
 * Encrypts plaintext using authenticated AES-256-GCM.
 * Output format: <iv_hex_24>:<auth_tag_hex_32>:<cipher_hex>
 */
export function encrypt(text: string): string {
  if (!text) return text;
  if (isEncrypted(text)) return text; // Idempotent

  const key = getDerivedEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts an authenticated AES-256-GCM encrypted string.
 * Supports both standard (iv:authTag:cipher) and versioned (enc:v1:iv:authTag:cipher) formats.
 * Transparently returns plaintext if text is not encrypted.
 */
export function decrypt(encryptedText: string): string {
  if (!encryptedText) return encryptedText;

  if (!isEncrypted(encryptedText)) {
    return encryptedText;
  }

  let ivHex: string;
  let authTagHex: string;
  let cipherHex: string;

  if (encryptedText.startsWith('enc:v1:')) {
    const parts = encryptedText.split(':');
    ivHex = parts[2]!;
    authTagHex = parts[3]!;
    cipherHex = parts[4]!;
  } else {
    const parts = encryptedText.split(':');
    ivHex = parts[0]!;
    authTagHex = parts[1]!;
    cipherHex = parts[2]!;
  }

  const key = getDerivedEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Safe encryption wrapper that guarantees idempotency.
 * If text is already encrypted, returns as is.
 */
export function safeEncrypt(text: string): string {
  if (!text) return text;
  if (isEncrypted(text)) return text;
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
