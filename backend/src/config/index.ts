import dotenv from 'dotenv';
import path from 'path';

// Load .env from the directory where the process was started (project root).
// process.cwd() is reliable for both ts-node-dev and compiled dist/.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// ─── Helper ───────────────────────────────────────────────────────────────────
function getEnv(key: string, defaultValue = ''): string {
  return process.env[key] ?? defaultValue;
}

// ─── Config Object ────────────────────────────────────────────────────────────
export const config = {
  app: {
    port: parseInt(process.env['PORT'] ?? '5001', 10),
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    isDev: (process.env['NODE_ENV'] ?? 'development') === 'development',
    isProd: process.env['NODE_ENV'] === 'production',
    rateLimitWindow: parseInt(process.env['RATE_LIMIT_WINDOW_SECONDS'] ?? '3600', 10),
    globalHourlyLimit: (() => {
      const val = process.env['GLOBAL_EMAILS_PER_HOUR'];
      if (!val) return 0;
      const parsed = parseInt(val, 10);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
    })(),
    workerConcurrency: (() => {
      const val = process.env['WORKER_CONCURRENCY'];
      if (!val) return 2;
      const parsed = parseInt(val, 10);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : 2;
    })(),
    emailSendDelayMs: (() => {
      const val = process.env['SEND_DELAY_TEST_MS'] ?? process.env['EMAIL_SEND_DELAY_MS'];
      if (val === undefined || val === '') {
        return 2000; // default
      }
      const parsed = Number(val);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return 2000;
      }
      return parsed;
    })(),
  },

  db: {
    url: getEnv('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/reachinbox'),
  },

  redis: {
    url: process.env['REDIS_URL'],
    host: process.env['REDIS_HOST'] ?? 'localhost',
    port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
  },

  // ─── Google OAuth ────────────────────────────────────────────────────────────
  google: {
  clientId: getEnv('GOOGLE_CLIENT_ID'),
  clientSecret: getEnv('GOOGLE_CLIENT_SECRET'),
  callbackUrl: getEnv(
    'GOOGLE_CALLBACK_URL',
    'http://localhost:5002/auth/google/callback',
  ),
},

  // ─── Slack OAuth ─────────────────────────────────────────────────────────────
  slack: {
    clientId: process.env['SLACK_CLIENT_ID'],
    clientSecret: process.env['SLACK_CLIENT_SECRET'],
    redirectUri:
      process.env['SLACK_REDIRECT_URI'] ??
      'http://localhost:5001/auth/slack/callback',
  },

  // ─── Session & Encryption ────────────────────────────────────────────────────
  session: {
    secret: getEnv('SESSION_SECRET', 'reachinbox-default-secret-key-32chars-min!!'),
  },

  crypto: {
    encryptionKey: process.env['ENCRYPTION_KEY'] || '',
  },

  // ─── SMTP / Ethereal ────────────────────────────────────────────────────────
  smtp: {
    host: process.env['SMTP_HOST'] ?? 'smtp.ethereal.email',
    port: parseInt(process.env['SMTP_PORT'] ?? '587', 10),
    secure: process.env['SMTP_SECURE'] === 'true',
    user: getEnv('SMTP_USER', 'yictoylywednjiug@ethereal.email'),
    pass: getEnv('SMTP_PASS', 'nTeCFEYgHEVPDh8dTx'),
    from: process.env['EMAIL_FROM'] ?? 'yictoylywednjiug@ethereal.email',
  },

  // ─── Admin & Dashboard ──────────────────────────────────────────────────────
  admin: {
    userIds: (process.env['ADMIN_USER_IDS'] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    emails: (process.env['ADMIN_EMAILS'] ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    boardEnabled: process.env['BULL_BOARD_ENABLED'] !== 'false',
  },
} as const;
