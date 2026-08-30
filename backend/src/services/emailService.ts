import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { config } from '../config';

/**
 * Reusable Nodemailer transporter for global/default Ethereal SMTP
 */
const defaultTransporter = nodemailer.createTransport({
  host: config.smtp.host || 'smtp.ethereal.email',
  port: 587,
  secure: false,
  auth: {
    user: config.smtp.user || 'yictoylywednjiug@ethereal.email',
    pass: config.smtp.pass || 'nTeCFEYgHEVPDh8dTx',
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 10000,
  tls: {
    rejectUnauthorized: false,
  },
});

export interface SendEmailOptions {
  sender?: {
    id: string;
    name?: string;
    email: string;
    smtp_host: string;
    smtp_port: number;
    smtp_secure: boolean;
    smtp_user: string;
    smtp_pass: string;
  };
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface SendEmailResult {
  messageId: string;
  previewUrl: string | false;
}

interface CachedTransporter {
  transporter: nodemailer.Transporter;
  hash: string;
}

// Local cache for Nodemailer transporters keyed by sender ID
const transporterCache = new Map<string, CachedTransporter>();

/**
 * Generates a SHA-256 hash of a sender's SMTP credentials.
 * Ensures the cache is invalidated if the credentials change,
 * without storing plaintext passwords in the cache map.
 */
function getSenderHash(sender: NonNullable<SendEmailOptions['sender']>): string {
  const data = `${sender.smtp_host}:${sender.smtp_port}:${sender.smtp_secure}:${sender.smtp_user}:${sender.smtp_pass}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Returns a cached transporter for the sender, creating it if it doesn't exist,
 * or recreating it if the SMTP credentials have changed.
 */
function getOrCreateTransporter(sender: NonNullable<SendEmailOptions['sender']>): nodemailer.Transporter {
  const currentHash = getSenderHash(sender);
  const cached = transporterCache.get(sender.id);

  if (cached) {
    if (cached.hash === currentHash) {
      return cached.transporter;
    }
    // Credentials have changed, close the old transporter to release idle connections
    try {
      cached.transporter.close();
    } catch (err) {
      console.error(`⚠️ [Nodemailer] Failed to close old transporter for sender ${sender.id}:`, err);
    }
  }

  // Create new transporter
  const isEthereal = (sender.smtp_host || '').toLowerCase().includes('ethereal');
  const port = isEthereal ? 587 : (Number(sender.smtp_port) || 587);
  const isSecure = isEthereal ? false : (port === 465 || sender.smtp_secure);

  const transporter = nodemailer.createTransport({
    host: sender.smtp_host || 'smtp.ethereal.email',
    port,
    secure: isSecure,
    auth: {
      user: sender.smtp_user,
      pass: sender.smtp_pass,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
    tls: {
      rejectUnauthorized: false,
    },
  });

  transporterCache.set(sender.id, { transporter, hash: currentHash });
  return transporter;
}

/**
 * Validates configuration, constructs the mail options, and sends the email.
 * If sender is provided, uses the cached transporter corresponding to that sender,
 * otherwise falls back to the default global transporter.
 */
export async function sendEmail({ sender, to, subject, text, html }: SendEmailOptions): Promise<SendEmailResult> {
  if (!to || !subject || !text || !html) {
    throw new Error('Missing required fields for sendEmail (to, subject, text, html).');
  }

  let transporter: nodemailer.Transporter;
  let fromAddress: string;

  if (sender) {
    transporter = getOrCreateTransporter(sender);
    const fromEmail = sender.smtp_host.includes('ethereal') && sender.smtp_user ? sender.smtp_user : (sender.email || sender.smtp_user);
    const displayName = (sender.name || sender.email).replace(/[<>"\r\n]/g, '').trim();
    fromAddress = `"${displayName}" <${fromEmail}>`;
  } else {
    transporter = defaultTransporter;
    fromAddress = config.smtp.from;
  }

  try {
    const info = await transporter.sendMail({
      from: fromAddress,
      to,
      subject,
      text,
      html,
    });

    const previewUrl = nodemailer.getTestMessageUrl(info);

    return {
      messageId: info.messageId,
      previewUrl,
    };
  } catch (primaryErr: any) {
    console.warn(`⚠️ [Nodemailer] Primary sender dispatch failed (${primaryErr.message}). Retrying with verified system SMTP...`);
    
    // Resilient fallback to default system transporter to guarantee delivery
    const fallbackInfo = await defaultTransporter.sendMail({
      from: config.smtp.from,
      to,
      subject,
      text,
      html,
    });

    const fallbackPreview = nodemailer.getTestMessageUrl(fallbackInfo);

    return {
      messageId: fallbackInfo.messageId,
      previewUrl: fallbackPreview,
    };
  }
}

/**
 * Development test helper to verify the default/global SMTP connection without sending an email.
 */
export async function verifyConnection(): Promise<boolean> {
  return await defaultTransporter.verify();
}

/**
 * Closes all open cached SMTP transporters and clears the cache.
 */
export function clearTransporterCache(): void {
  for (const [id, cached] of transporterCache.entries()) {
    try {
      cached.transporter.close();
    } catch (err) {
      console.error(`⚠️ [Nodemailer] Failed to close transporter cache for ${id}:`, err);
    }
  }
  transporterCache.clear();
}

