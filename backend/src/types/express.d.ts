/**
 * src/types/express.d.ts
 *
 * Extends Express and express-session type definitions so TypeScript
 * recognises req.user and req.session throughout the application.
 */

import { UserRow } from './db.types';

// Tell Passport / Express what req.user looks like.
declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface User extends UserRow {}
  }
}

declare module 'express-session' {
  interface SessionData {
    slackState?: string;
  }
}

export {};