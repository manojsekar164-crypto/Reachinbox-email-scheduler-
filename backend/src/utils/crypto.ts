import crypto from 'crypto';
import { config } from '../config';

// Derive a secure 32-byte key from the session secret or a dedicated encryption key
const SECRET = process.env['ENCRYPTION_KEY'] || config.session.secret;
const ENCRYPTION_KEY = crypto.createHash('sha256').update(SECRET).digest();
const IV_LENGTH = 12; // Standard IV length for AES-GCM
const CIPHER_REGEX = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i;

/**
 * Encrypts a string using AES-256-GCM.
 * Returns a colon-separated string: iv:authTag:encryptedText
 */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts a string encrypted with AES-256-GCM.
 * Expects format: iv:authTag:encryptedText
 */
export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted text format. Expected iv:authTag:encrypted');
  }

  const iv = Buffer.from(parts[0]!, 'hex');
  const authTag = Buffer.from(parts[1]!, 'hex');
  const encrypted = parts[2]!;

  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Determines whether a string matches the AES-256-GCM encrypted format (iv:authTag:cipher).
 */
export function isEncrypted(text: string): boolean {
  return CIPHER_REGEX.test(text);
}

/**
 * Safely encrypts plaintext with AES-256-GCM. If text is already encrypted, returns as is.
 */
export function safeEncrypt(text: string): string {
  if (!text) return text;
  if (isEncrypted(text)) return text;
  return encrypt(text);
}

/**
 * Safely decrypts an encrypted string. If text is not encrypted or decryption fails, returns original text.
 */
export function safeDecrypt(text: string): string {
  if (!text) return text;
  if (!isEncrypted(text)) return text;
  try {
    return decrypt(text);
  } catch {
    return text;
  }
}
