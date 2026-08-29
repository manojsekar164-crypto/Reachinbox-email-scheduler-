/**
 * src/middleware/requireAuth.ts
 *
 * Reusable Express middleware that protects routes requiring authentication.
 *
 * Behaviour:
 *   - Authenticated request  → calls next()
 *   - Unauthenticated request → responds with HTTP 401 JSON
 *
 * Note: This middleware does NOT redirect to /auth/google automatically.
 * API routes should never redirect; they return a machine-readable 401
 * so that clients can decide what to do (e.g. show a login button).
 */

import { Request, Response, NextFunction } from 'express';
import { UserRow } from '../types/db.types';

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Testing backdoor: if running in test environment or explicitly enabled,
  // allow passing 'x-test-user-id' header to bypass Google OAuth session verification.
  if (process.env.NODE_ENV === 'test' || process.env.ALLOW_TEST_AUTH === 'true') {
    const testUserId = req.headers['x-test-user-id'];
    if (testUserId && typeof testUserId === 'string') {
      req.user = {
        id: testUserId,
        email: 'test-api-bypass@reachinbox.test',
        name: 'Test API Bypass User',
        google_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      } as UserRow;
      
      next();
      return;
    }
  }

  if (req.isAuthenticated()) {
    next();
    return;
  }

  res.status(401).json({ error: 'Authentication required' });
}