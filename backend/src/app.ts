import express, { Application } from 'express';
import cors from 'cors';
import session from 'express-session';
import { config } from './config';
import rootRouter from './routes';
import { notFoundHandler, errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';

// Import passport AFTER config so that requireEnv has already run.
import passportInstance from './auth/passport';

/**
 * Creates and configures the Express application.
 * Kept separate from the HTTP server so the app can be imported in tests.
 *
 * Middleware order (MUST be preserved):
 *   CORS
 *   Body parsers
 *   Request logger
 *   express-session       ← session must come before Passport
 *   passport.initialize() ← Passport reads req.session
 *   passport.session()    ← restores req.user via deserializeUser
 *   Routes
 *   404 handler
 *   Error handler
 *
 * SESSION STORE NOTE:
 *   The default MemoryStore is used here for development convenience.
 *   MemoryStore is NOT suitable for production because:
 *     1. Sessions are lost on server restart.
 *     2. It leaks memory in long-running processes.
 *     3. It does not work across multiple server instances.
 *   For production, replace MemoryStore with a persistent store such as
 *   connect-redis (using the existing Redis instance) or connect-pg-simple.
 */
export function createApp(): Application {
  const app = express();

  // ─── Security / Parsing ─────────────────────────────────────────────────────
  const allowedOrigins = process.env['ALLOWED_ORIGINS']
    ? process.env['ALLOWED_ORIGINS'].split(',').map((o) => o.trim())
    : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:5001'];

  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps, curl, or same-origin)
        if (!origin) return callback(null, true);
        if (config.app.isDev || allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error(`CORS origin "${origin}" not allowed.`));
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ─── Logging ────────────────────────────────────────────────────────────────
  app.use(requestLogger);

  // ─── Session ─────────────────────────────────────────────────────────────────
  // Must be registered BEFORE passport middleware.
  app.use(
    session({
      secret: config.session.secret,
      resave: false,           // don't write session back if unmodified
      saveUninitialized: false, // don't create session until something is stored
      cookie: {
        httpOnly: true,        // not accessible from JavaScript in the browser
        secure: false,         // false for local HTTP development; set true in prod
        sameSite: 'lax',       // CSRF protection while allowing top-level navigations
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
      },
    }),
  );

  // ─── Passport ───────────────────────────────────────────────────────────────
  app.use(passportInstance.initialize());
  app.use(passportInstance.session());

  // ─── Routes ─────────────────────────────────────────────────────────────────
  app.use('/', rootRouter);

  // ─── Error Handling ─────────────────────────────────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}