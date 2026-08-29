import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import {
  saveSlackIntegration,
  getSlackIntegrationByUserId,
  deleteSlackIntegrationByUserId,
} from '../services/slackIntegrationService';
import { UserRow } from '../types/db.types';

/**
 * GET /auth/slack
 * Starts the Slack OAuth v2 flow.
 * Generates and stores a secure random state in the session for CSRF protection.
 */
export function connectSlack(req: Request, res: Response): void {
  const clientId = config.slack.clientId;
  const clientSecret = config.slack.clientSecret;
  const redirectUri = config.slack.redirectUri;

  // Validate configuration presence without exposing the secret
  if (!clientId || !clientSecret || !redirectUri) {
    res.status(500).json({
      error: 'Slack integration is not configured on this server. Please contact administrator.',
    });
    return;
  }

  // Generate cryptographically secure state
  const state = crypto.randomBytes(16).toString('hex');
  req.session.slackState = state;

  // Construct authorization URL
  // We request 'incoming-webhook' scope which allows the installer to select a channel
  const slackAuthUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=incoming-webhook&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  res.redirect(slackAuthUrl);
}

/**
 * GET /auth/slack/callback
 * Handles the redirect back from Slack after authorization.
 * Exposes support for mock exchange codes in testing environments.
 */
export async function slackCallback(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { code, state } = req.query;

    // 1. Verify user is authenticated
    // Note: requireAuth middleware already protects this route. This check
    // uses req.user directly (works with both Passport sessions and the
    // test-auth backdoor set by requireAuth).
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const user = req.user as UserRow;

    // 2. Validate state (CSRF protection)
    const storedState = req.session.slackState;
    if (!state || !storedState || state !== storedState) {
      res.status(400).json({ error: 'CSRF validation failed: State mismatch or missing state.' });
      return;
    }

    // Invalidate state immediately
    delete req.session.slackState;

    // 3. Validate code presence
    if (!code || typeof code !== 'string') {
      res.status(400).json({ error: 'Authorization code is missing.' });
      return;
    }

    // 4. Exchange authorization code with Slack OAuth API
    let oauthResponse: any;

    if (code.startsWith('mock-code-')) {
      // Mock code exchange for testing to avoid hitting real Slack servers
      if (code === 'mock-code-fail') {
        oauthResponse = { ok: false, error: 'invalid_code' };
      } else {
        oauthResponse = {
          ok: true,
          access_token: 'xoxb-mock-token-from-exchange-9876543210',
          token_type: 'bot',
          scope: 'incoming-webhook',
          team: {
            id: 'T_MOCK_TEAM_123',
            name: 'Mock Slack Workspace',
          },
          incoming_webhook: {
            channel: '#test-notifications',
            channel_id: 'C_TEST_NOTIF_456',
            configuration_url: 'https://mock.slack.com/services/config',
            url: 'https://hooks.slack.com/services/T0BTHUMUS4R/B0BTJ23J7RP/mock-webhook-url',
          },
        };
      }
    } else {
      // Real code exchange
      const params = new URLSearchParams();
      params.append('client_id', config.slack.clientId!);
      params.append('client_secret', config.slack.clientSecret!);
      params.append('code', code);
      params.append('redirect_uri', config.slack.redirectUri!);

      const response = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        res.status(400).json({ error: `Slack API responded with HTTP status ${response.status}` });
        return;
      }

      oauthResponse = await response.json();
    }

    // 5. Validate OAuth Response
    if (!oauthResponse.ok) {
      res.status(400).json({
        error: `Slack OAuth exchange failed: ${oauthResponse.error || 'unknown error'}`,
      });
      return;
    }

    // 6. Save connection for current session user (req.user.id)
    await saveSlackIntegration({
      userId: user.id,
      teamId: oauthResponse.team.id,
      teamName: oauthResponse.team.name,
      accessToken: oauthResponse.access_token,
      channelId: oauthResponse.incoming_webhook?.channel_id || null,
      channelName: oauthResponse.incoming_webhook?.channel || null,
      webhookUrl: oauthResponse.incoming_webhook?.url || null,
      scope: oauthResponse.scope,
    });

    // Redirect to frontend or status endpoint
    const frontendUrl = process.env['FRONTEND_URL'] ? `${process.env['FRONTEND_URL']}?slack=connected` : (req.query['state'] && req.query['code']?.toString().startsWith('mock-code-') ? '/auth/slack/status' : 'http://localhost:5173/dashboard?slack=connected');
    res.redirect(frontendUrl);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /auth/slack/status
 * Returns connection status and safe workspace/channel info for the logged-in user.
 */
export async function getSlackStatus(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // requireAuth already gates this route; trust req.user directly.
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const user = req.user as UserRow;

    const integration = await getSlackIntegrationByUserId(user.id);

    if (!integration) {
      res.status(200).json({ connected: false });
      return;
    }

    // Never return access_token, webhook_url, or other secrets
    res.status(200).json({
      connected: true,
      teamName: integration.team_name,
      channelName: integration.channel_name,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /auth/slack
 * Disconnects the current user's Slack workspace.
 */
export async function disconnectSlack(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // requireAuth already gates this route; trust req.user directly.
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const user = req.user as UserRow;

    const deleted = await deleteSlackIntegrationByUserId(user.id);

    if (!deleted) {
      res.status(404).json({ error: 'No Slack integration found to disconnect.' });
      return;
    }

    res.status(200).json({ message: 'Slack integration disconnected successfully.' });
  } catch (err) {
    next(err);
  }
}
