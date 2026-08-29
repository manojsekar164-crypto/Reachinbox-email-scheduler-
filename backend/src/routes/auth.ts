/**
 * src/routes/auth.ts
 *
 * Auth routes:
 *   GET  /auth/google           – start Google OAuth flow
 *   GET  /auth/google/callback  – handle Google's redirect back
 *   GET  /auth/me               – return current authenticated user
 *   POST /auth/logout           – destroy session
 */

import { Router } from 'express';
import passport from '../auth/passport';
import {
  getMe,
  logout,
  oauthSuccess,
  oauthFailure,
} from '../controllers/authController';
import { requireAuth } from '../middleware/requireAuth';
import {
  connectSlack,
  slackCallback,
  getSlackStatus,
  disconnectSlack,
} from '../controllers/slackAuthController';

const router = Router();

// ─── Start OAuth flow ─────────────────────────────────────────────────────────
// Passport redirects the browser to Google's authorization endpoint.
// The 'state' parameter (CSRF protection) is handled automatically by Passport.
router.get(
  '/google',
  passport.authenticate('google', {
    scope: ['openid', 'profile', 'email'],
  }),
);

// ─── OAuth callback ───────────────────────────────────────────────────────────
// Google redirects here after the user grants/denies consent.
// On success: Passport calls serializeUser, writes the session, then we redirect.
// On failure: respond with a JSON error.
router.get(
  '/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/auth/failure',
    session: true,
  }),
  oauthSuccess,
);

// ─── OAuth failure endpoint ───────────────────────────────────────────────────
router.get('/failure', oauthFailure);

// ─── Current user ─────────────────────────────────────────────────────────────
router.get('/me', getMe);

// ─── Logout ───────────────────────────────────────────────────────────────────
router.post('/logout', logout);

// ─── Slack OAuth ─────────────────────────────────────────────────────────────
router.get('/slack', requireAuth, connectSlack);
router.get('/slack/callback', requireAuth, slackCallback);
router.get('/slack/status', requireAuth, getSlackStatus);
router.delete('/slack', requireAuth, disconnectSlack);

export default router;