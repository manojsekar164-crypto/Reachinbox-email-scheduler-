
/**
 * src/routes/auth.ts
 *
 * Auth routes:
 *   GET    /auth/google           - Start Google OAuth flow
 *   GET    /auth/google/callback  - Handle Google OAuth callback
 *   GET    /auth/failure          - Handle OAuth failure
 *   GET    /auth/me               - Return current authenticated user
 *   POST   /auth/logout           - Destroy session
 *
 * Slack OAuth:
 *   GET    /auth/slack            - Start Slack OAuth flow
 *   GET    /auth/slack/callback   - Handle Slack OAuth callback
 *   GET    /auth/slack/status    - Get Slack connection status
 *   DELETE /auth/slack           - Disconnect Slack
 */

import { Router, type Request, type Response } from 'express';

import passport, {
  googleOAuthConfigured,
} from '../auth/passport';

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

// ============================================================
// GOOGLE OAUTH CONFIGURATION
// ============================================================

/**
 * Return a clear error when Google OAuth credentials
 * have not been configured.
 *
 * This allows the backend and Slack integration to operate
 * independently of Google OAuth.
 */
const googleOAuthUnavailable = (
  _req: Request,
  res: Response,
): void => {
  res.status(503).json({
    success: false,
    message:
      'Google OAuth is not configured. Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
  });
};

// ============================================================
// GOOGLE OAUTH ROUTES
// ============================================================

if (googleOAuthConfigured) {

  // Start Google OAuth flow.
  router.get(
    '/google',
    passport.authenticate('google', {
      scope: ['openid', 'profile', 'email'],
    }),
  );

  // Handle Google OAuth callback.
  router.get(
    '/google/callback',
    passport.authenticate('google', {
      failureRedirect: '/auth/failure',
      session: true,
    }),
    oauthSuccess,
  );

} else {

  // Google OAuth is unavailable until valid credentials exist.
  router.get('/google', googleOAuthUnavailable);

  router.get('/google/callback', googleOAuthUnavailable);

}

// ============================================================
// OAUTH FAILURE ROUTE
// ============================================================

router.get('/failure', oauthFailure);

// ============================================================
// CURRENT AUTHENTICATED USER
// ============================================================

router.get('/me', getMe);

// ============================================================
// LOGOUT
// ============================================================

router.post('/logout', logout);

// ============================================================
// SLACK OAUTH ROUTES
// ============================================================

// Start Slack OAuth authorization.
router.get(
  '/slack',
  requireAuth,
  connectSlack,
);

// Handle Slack OAuth callback.
router.get(
  '/slack/callback',
  requireAuth,
  slackCallback,
);

// Get current Slack integration status.
router.get(
  '/slack/status',
  requireAuth,
  getSlackStatus,
);

// Disconnect Slack integration.
router.delete(
  '/slack',
  requireAuth,
  disconnectSlack,
);

// ============================================================
// EXPORT ROUTER
// ============================================================

export default router;
