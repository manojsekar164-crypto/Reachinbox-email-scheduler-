import dotenv from 'dotenv';
import path from 'path';

// Load .env from the directory where the process was started (project root).
// process.cwd() is reliable for both ts-node-dev and compiled dist/.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// ─── Helper ───────────────────────────────────────────────────────────────────
function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

// ─── Config Object ────────────────────────────────────────────────────────────
export const config = {
  app: {
    port: parseInt(process.env['PORT'] ?? '5000', 10),
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    isDev: (process.env['NODE_ENV'] ?? 'development') === 'development',
    isProd: process.env['NODE_ENV'] === 'production',
    rateLimitWindow: parseInt(process.env['RATE_LIMIT_WINDOW_SECONDS'] ?? '3600', 10),
    emailSendDelayMs: (() => {
      const val = process.env['SEND_DELAY_TEST_MS'] ?? process.env['EMAIL_SEND_DELAY_MS'];
      if (val === undefined || val === '') {
        return 2000; // default
      }
      const parsed = Number(val);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`Invalid EMAIL_SEND_DELAY_MS: "${val}". Must be an integer >= 0.`);
      }
      if (parsed > 86400000) {
        throw new Error(`Invalid EMAIL_SEND_DELAY_MS: "${val}". Value exceeds reasonable limit of 24 hours (86400000 ms).`);
      }
      return parsed;
    })(),
  },

  db: {
    url: requireEnv('DATABASE_URL'),
  },

  redis: {
    url: process.env['REDIS_URL'],
    host: process.env['REDIS_HOST'] ?? 'localhost',
    port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
  },

  // ─── Google OAuth ────────────────────────────────────────────────────────────
  google: {
    clientId: requireEnv('GOOGLE_CLIENT_ID'),
    clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
    callbackUrl:
      process.env['GOOGLE_CALLBACK_URL'] ??
      'http://localhost:5001/auth/google/callback',
  },

  // ─── Slack OAuth ─────────────────────────────────────────────────────────────
  slack: {
    clientId: process.env['SLACK_CLIENT_ID'],
    clientSecret: process.env['SLACK_CLIENT_SECRET'],
    redirectUri:
      process.env['SLACK_REDIRECT_URI'] ??
      'http://localhost:5001/auth/slack/callback',
  },

  // ─── Session ─────────────────────────────────────────────────────────────────
  session: {
    secret: requireEnv('SESSION_SECRET'),
  },

  // ─── SMTP / Ethereal ────────────────────────────────────────────────────────
  smtp: {
    host: process.env['SMTP_HOST'] ?? 'smtp.ethereal.email',
    port: parseInt(process.env['SMTP_PORT'] ?? '587', 10),
    secure: process.env['SMTP_SECURE'] === 'true',
    user: requireEnv('SMTP_USER'),
    pass: requireEnv('SMTP_PASS'),
    from: process.env['EMAIL_FROM'] ?? 'no-reply@reachinbox.test',
  },
} as const;