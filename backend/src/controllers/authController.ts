/**
 * src/controllers/authController.ts
 *
 * Handles /auth/me and /auth/logout.
 * /auth/google and /auth/google/callback are handled directly by Passport
 * middleware in the route file (no custom controller logic needed there).
 */

import { Request, Response, NextFunction } from 'express';
import { UserRow } from '../types/db.types';

/**
 * GET /auth/me
 *
 * Returns the currently authenticated user or an unauthenticated marker.
 * Always responds with HTTP 200 – callers check the "authenticated" field.
 */
export function getMe(req: Request, res: Response): void {
  if (req.isAuthenticated() && req.user) {
    const user = req.user as UserRow;
    res.status(200).json({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    });
    return;
  }

  res.status(200).json({
    authenticated: false,
    user: null,
  });
}

/**
 * POST /auth/logout
 *
 * Destroys the server-side session and clears the session cookie.
 */
export function logout(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  req.logout((err) => {
    if (err) {
      return next(err);
    }

    req.session.destroy((destroyErr) => {
      if (destroyErr) {
        // Log but don't block – the user is effectively logged out
        // from Passport's perspective even if session destruction fails.
        console.error('Session destroy error:', destroyErr);
      }
      res.clearCookie('connect.sid');
      res.status(200).json({ message: 'Logged out successfully' });
    });
  });
}

/**
 * Handler called by Passport after a successful Google OAuth callback.
 * Redirects the browser to a simple success JSON endpoint.
 */
export function oauthSuccess(_req: Request, res: Response): void {
  const frontendUrl = process.env['FRONTEND_URL'] ?? 'http://localhost:5173/dashboard';
  res.redirect(frontendUrl);
}

/**
 * Handler called when Google OAuth fails (user denies consent, etc.).
 */
export function oauthFailure(_req: Request, res: Response): void {
  res.status(401).json({
    authenticated: false,
    error: 'Google authentication failed or was cancelled',
  });
}