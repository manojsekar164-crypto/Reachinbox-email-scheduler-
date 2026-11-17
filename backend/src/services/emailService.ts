import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { config } from '../config';

/**
 * State tracking for active SMTP sessions to distinguish pre-DATA network drops
 * from post-DATA ambiguous connection drops.
 */
interface SessionStage {
  lastCmd: string | null;
  dataSent: boolean;
}

/**
 * Creates an instrumented Nodemailer transporter that tracks session stages.
 * This guarantees strict compliance with conservative SMTP classification:
 * network drop before DATA -> connection_failure (retryable)
 * network drop during/after DATA -> ambiguous_outcome (in-doubt, non-retryable)
 */
export function createTrackedTransporter(options: any): nodemailer.Transporter {
  const sessionStages = new Map<string, SessionStage>();
  const activeCallSidSets: Set<string>[] = [];

  const transporter = nodemailer.createTransport({
    ...options,
    debug: true,
    logger: {
      debug: (entry: any, ...args: any[]) => {
        if (!entry || !entry.sid) return;
        const sid = String(entry.sid);
        for (const sids of activeCallSidSets) {
          sids.add(sid);
        }
        const st = sessionStages.get(sid) || { lastCmd: null, dataSent: false };
        if (entry.tnx === 'client') {
          st.lastCmd = String(args[0] || '').split(/[\s:<]/)[0].toUpperCase();
          if (st.lastCmd === 'DATA') {
            st.dataSent = true;
          }
        } else if (entry.tnx === 'message') {
          st.dataSent = true;
        }
        sessionStages.set(sid, st);
      },
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  });

  const origSendMail = transporter.sendMail.bind(transporter);
  transporter.sendMail = async function (mailOpts: any) {
    const callSids = new Set<string>();
    activeCallSidSets.push(callSids);
    try {
      return await origSendMail(mailOpts);
    } catch (err: any) {
      for (const sid of callSids) {
        const st = sessionStages.get(sid);
        if (st?.dataSent) {
          err.dataSent = true;
          err.command = 'DATA';
          break;
        } else if (st?.lastCmd && (!err.command || err.command === 'CONN')) {
          err.lastCommand = st.lastCmd;
        }
      }
      throw err;
    } finally {
      const idx = activeCallSidSets.indexOf(callSids);
      if (idx !== -1) {
        activeCallSidSets.splice(idx, 1);
      }
      for (const sid of callSids) {
        sessionStages.delete(sid);
      }
    }
  };

  return transporter;
}

/**
 * Reusable Nodemailer transporter for global/default Ethereal SMTP
 */
let defaultTransporter = createTrackedTransporter({
  host: config.smtp.host || 'smtp.ethereal.email',
  port: Number(config.smtp.port) || 587,
  secure: false,
  auth: {
    user: config.smtp.user || 'yictoylywednjiug@ethereal.email',
    pass: config.smtp.pass || 'nTeCFEYgHEVPDh8dTx',
  },
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 5000,
  tls: {
    rejectUnauthorized: false,
  },
});

/**
 * Test helper to override or reset default transporter (e.g. For mock/local SMTP servers).
 */
export function setDefaultTransporter(transporter: nodemailer.Transporter): void {
  defaultTransporter = transporter;
}

export function resetDefaultTransporter(): void {
  defaultTransporter = createTrackedTransporter({
    host: config.smtp.host || 'smtp.ethereal.email',
    port: Number(config.smtp.port) || 587,
    secure: false,
    auth: {
      user: config.smtp.user || 'yictoylywednjiug@ethereal.email',
      pass: config.smtp.pass || 'nTeCFEYgHEVPDh8dTx',
    },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000,
    tls: {
      rejectUnauthorized: false,
    },
  });
}

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
  response?: string;
  accepted?: string[];
  rejected?: string[];
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

  const transporter = createTrackedTransporter({
    host: sender.smtp_host || 'smtp.ethereal.email',
    port,
    secure: isSecure,
    auth: sender.smtp_user
      ? {
          user: sender.smtp_user,
          pass: sender.smtp_pass || '',
        }
      : undefined,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000,
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
 * otherwise falls back to the default global transporter only when permitted.
 *
 * Invariant: Never automatically falls back to default sender when selected sender fails!
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
      response: info.response,
      accepted: Array.isArray(info.accepted) ? info.accepted.map(String) : [],
      rejected: Array.isArray(info.rejected) ? info.rejected.map(String) : [],
    };
  } catch (primaryErr: any) {
    if (sender) {
      console.error(
        `❌ [Nodemailer] SMTP dispatch failed for explicit sender ${sender.id} (${sender.email}): ${primaryErr.message}. Preserving sender identity without fallback.`
      );
    } else {
      console.error(
        `❌ [Nodemailer] Default system SMTP dispatch failed: ${primaryErr.message}`
      );
    }
    throw primaryErr;
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

