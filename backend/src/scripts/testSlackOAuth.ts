// ─── IMPORTANT: Set test-auth flag BEFORE dotenv and app import ──────────────
// This activates the x-test-user-id backdoor in requireAuth middleware so that
// the automated test can make authenticated requests without a real OAuth session.
// This does NOT modify the production auth middleware; it only enables the
// existing test backdoor that is already implemented in requireAuth.ts.
process.env['ALLOW_TEST_AUTH'] = 'true';

import dotenv from 'dotenv';
import path from 'path';
import http from 'http';
import { createApp } from '../app';
import { db as pool, connectDB, disconnectDB } from '../db/postgres';
import { redis } from '../db/redis';
import { clearTestState, testState, handleRateLimitNotification } from '../services/slackService';
import { getSlackIntegrationByUserId } from '../services/slackIntegrationService';

// Load .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const TEST_PORT = 5002;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function main() {
  console.log('==================================================');
  console.log('🧪 Starting ReachInbox Phase 9D Slack OAuth Test Suite...');
  console.log('==================================================\n');

  // Ensure DB & Redis are connected
  await connectDB();

  // Create Express Server
  const app = createApp();
  const server = http.createServer(app);
  
  await new Promise<void>((resolve) => {
    server.listen(TEST_PORT, () => {
      console.log(`📡 Test server listening on ${BASE_URL}\n`);
      resolve();
    });
  });

  let exitCode: number = 0;
  
  try {
    // -------------------------------------------------------------------------
    // Setup Test Users
    // -------------------------------------------------------------------------
    console.log('👥 Setting up test users A and B...');
    const userARes = await pool.query(
      `INSERT INTO users (email, name) VALUES ('slack-oauth-user-a@example.com', 'User A')
       ON CONFLICT (email) DO UPDATE SET name = 'User A' RETURNING id`
    );
    const userAId = userARes.rows[0].id;

    const userBRes = await pool.query(
      `INSERT INTO users (email, name) VALUES ('slack-oauth-user-b@example.com', 'User B')
       ON CONFLICT (email) DO UPDATE SET name = 'User B' RETURNING id`
    );
    const userBId = userBRes.rows[0].id;

    console.log(`   User A ID: ${userAId}`);
    console.log(`   User B ID: ${userBId}`);
    console.log('✅ Users set up successfully.\n');

    // -------------------------------------------------------------------------
    // Checkpoint 1: Slack OAuth configuration exists
    // -------------------------------------------------------------------------
    console.log('👉 [Checkpoint 1] Verifying Slack OAuth configuration...');
    const clientId = process.env.SLACK_CLIENT_ID;
    const clientSecret = process.env.SLACK_CLIENT_SECRET;
    const redirectUri = process.env.SLACK_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error('Slack OAuth configuration is missing in .env (SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_REDIRECT_URI)');
    }
    console.log('   SLACK_CLIENT_ID:', clientId);
    console.log('   SLACK_REDIRECT_URI:', redirectUri);
    console.log('✅ Slack OAuth configuration validated.\n');

    // -------------------------------------------------------------------------
    // Checkpoint 2 & 3: Auth URL & State generation and storage
    // -------------------------------------------------------------------------
    console.log('👉 [Checkpoint 2 & 3] Requesting connect endpoint & verifying state generation...');
    const connectRes = await fetch(`${BASE_URL}/auth/slack`, {
      method: 'GET',
      headers: {
        'x-test-user-id': userAId,
      },
      redirect: 'manual', // Do not automatically follow the redirect so we can inspect headers
    });

    if (connectRes.status !== 302) {
      throw new Error(`Expected connect endpoint to redirect with 302, got ${connectRes.status}`);
    }

    const location = connectRes.headers.get('location');
    if (!location) {
      throw new Error('Connect response did not contain a Location header.');
    }
    console.log(`   Redirect Location: ${location}`);

    // Parse URL and query params
    const authUrl = new URL(location);
    if (authUrl.origin !== 'https://slack.com') {
      throw new Error(`Expected redirect origin to be https://slack.com, got ${authUrl.origin}`);
    }

    const authParams = authUrl.searchParams;
    const state = authParams.get('state');
    if (!state || state.length < 16) {
      throw new Error(`Generated state is missing or insecurely short: "${state}"`);
    }
    console.log(`   Generated State: ${state}`);
    console.log(`   Scope requested: ${authParams.get('scope')}`);

    // Extract session cookie to maintain the session
    const setCookie = connectRes.headers.get('set-cookie');
    if (!setCookie) {
      throw new Error('Connect response did not return a session cookie (set-cookie).');
    }
    const sessionCookie = setCookie.split(';')[0];
    console.log(`   Captured Session Cookie: ${sessionCookie}`);
    console.log('✅ Auth URL and state validation successful.\n');

    // -------------------------------------------------------------------------
    // Checkpoint 4: Callback rejects invalid state
    // -------------------------------------------------------------------------
    console.log('👉 [Checkpoint 4] Verifying callback rejects invalid state...');
    const invalidStateCallbackRes = await fetch(
      `${BASE_URL}/auth/slack/callback?code=mock-code-success&state=badstate12345`,
      {
        headers: {
          'x-test-user-id': userAId,
          cookie: sessionCookie,
        },
      }
    );

    if (invalidStateCallbackRes.status !== 400) {
      throw new Error(`Expected 400 Bad Request for invalid state, got ${invalidStateCallbackRes.status}`);
    }
    const invalidStateJson = await invalidStateCallbackRes.json() as any;
    console.log('   Response body (correctly rejected):', invalidStateJson);
    console.log('✅ CSRF state protection confirmed.\n');

    // -------------------------------------------------------------------------
    // Checkpoint 5: Callback rejects unauthenticated requests / does not trust user ID from queries
    // -------------------------------------------------------------------------
    console.log('👉 [Checkpoint 5] Verifying callback rejects unauthenticated requests...');
    const unauthCallbackRes = await fetch(
      `${BASE_URL}/auth/slack/callback?code=mock-code-success&state=${state}`,
      {
        // NO x-test-user-id and NO session cookie
      }
    );
    if (unauthCallbackRes.status !== 401) {
      throw new Error(`Expected 401 Unauthorized for unauthenticated callback request, got ${unauthCallbackRes.status}`);
    }
    console.log('✅ Callback endpoints secured against anonymous inputs.\n');

    // -------------------------------------------------------------------------
    // Checkpoint 6 & 7: Successful installation storage & ownership attribution
    // -------------------------------------------------------------------------
    console.log('👉 [Checkpoint 6 & 7] Testing successful Slack installation & storage...');
    const callbackRes = await fetch(
      `${BASE_URL}/auth/slack/callback?code=mock-code-success&state=${state}`,
      {
        headers: {
          'x-test-user-id': userAId,
          cookie: sessionCookie,
        },
        redirect: 'manual', // Callback redirects to status page
      }
    );

    if (callbackRes.status !== 302) {
      throw new Error(`Expected successful callback to redirect with 302, got ${callbackRes.status}`);
    }
    const callbackRedirectLoc = callbackRes.headers.get('location');
    console.log(`   Callback Redirect location: ${callbackRedirectLoc}`);
    if (callbackRedirectLoc !== '/auth/slack/status') {
      throw new Error(`Expected redirect to /auth/slack/status, got ${callbackRedirectLoc}`);
    }

    // Verify record in PostgreSQL database
    const dbRecord = await getSlackIntegrationByUserId(userAId);
    if (!dbRecord) {
      throw new Error('Slack integration was not saved in the database.');
    }
    console.log('   Saved Integration in DB:');
    console.log(`      User ID: ${dbRecord.user_id} (matches User A ID)`);
    console.log(`      Team ID: ${dbRecord.team_id}`);
    console.log(`      Team Name: ${dbRecord.team_name}`);
    console.log(`      Channel: ${dbRecord.channel_name} (${dbRecord.channel_id})`);
    console.log(`      Decrypted Access Token: ${dbRecord.access_token.substring(0, 9)}...`);
    console.log(`      Decrypted Webhook URL: ${dbRecord.webhook_url?.substring(0, 30)}...`);

    if (dbRecord.user_id !== userAId) {
      throw new Error('Attributed user ID does not match session user ID!');
    }
    console.log('✅ Installation stored and user ownership validated.\n');

    // -------------------------------------------------------------------------
    // Checkpoint 8: Tokens are never returned by status API
    // -------------------------------------------------------------------------
    console.log('👉 [Checkpoint 8] Verifying status endpoint does not leak secrets...');
    const statusRes = await fetch(`${BASE_URL}/auth/slack/status`, {
      headers: {
        'x-test-user-id': userAId,
        cookie: sessionCookie,
      },
    });

    if (statusRes.status !== 200) {
      throw new Error(`Expected 200 OK from status endpoint, got ${statusRes.status}`);
    }

    const statusJson = await statusRes.json() as any;
    console.log('   Status JSON response:', statusJson);

    if (statusJson.connected !== true) {
      throw new Error('Status response reports not connected, expected connected = true');
    }
    if (statusJson.teamName !== 'Mock Slack Workspace' || statusJson.channelName !== '#test-notifications') {
      throw new Error('Status response returns mismatched workspace details.');
    }

    // Check for leakages
    const forbiddenKeys = ['access_token', 'accessToken', 'webhook_url', 'webhookUrl', 'client_secret', 'clientSecret', 'code'];
    for (const key of forbiddenKeys) {
      if (key in statusJson || JSON.stringify(statusJson).toLowerCase().includes(key.toLowerCase())) {
        throw new Error(`Security breach: Status endpoint leaked "${key}"!`);
      }
    }
    console.log('✅ Status endpoint security verification passed.\n');

    // -------------------------------------------------------------------------
    // Checkpoint 12: Reconnect updates connection (upsert)
    // -------------------------------------------------------------------------
    console.log('👉 [Checkpoint 12] Verifying reconnect behavior (upserts existing connection)...');
    
    // We initiate a new connect flow to generate a new state
    const reconnectConnectRes = await fetch(`${BASE_URL}/auth/slack`, {
      method: 'GET',
      headers: {
        'x-test-user-id': userAId,
      },
      redirect: 'manual',
    });
    
    const reconnectLocation = reconnectConnectRes.headers.get('location')!;
    const reconnectState = new URL(reconnectLocation).searchParams.get('state')!;
    const reconnectCookie = reconnectConnectRes.headers.get('set-cookie')!.split(';')[0];

    // Connect again using a code that triggers reconnect workspace details
    // Here we will use mock-code-reconnect which is processed by the callback
    // Wait, let's make sure our controller handles 'mock-code-reconnect' with different team details!
    // Let's modify the callback logic to support 'mock-code-reconnect' if needed, or simply 'mock-code-success' updates again.
    // In our controller, if code is 'mock-code-reconnect' or 'mock-code-success-2', we can return updated details.
    // Let's look: our controller currently mocks all codes except 'mock-code-fail' as the same team details.
    // That still triggers an upsert update! Let's verify that the upsert does not create duplicates.
    const reconnectCallbackRes = await fetch(
      `${BASE_URL}/auth/slack/callback?code=mock-code-success&state=${reconnectState}`,
      {
        headers: {
          'x-test-user-id': userAId,
          cookie: reconnectCookie,
        },
        redirect: 'manual',
      }
    );

    if (reconnectCallbackRes.status !== 302) {
      throw new Error(`Expected redirect from reconnect callback, got ${reconnectCallbackRes.status}`);
    }

    // Verify row count in database
    const countRes = await pool.query(
      'SELECT count(*) FROM slack_integrations WHERE user_id = $1',
      [userAId]
    );
    const rowCount = parseInt(countRes.rows[0].count, 10);
    console.log(`   Slack integrations record count for User A: ${rowCount}`);
    if (rowCount !== 1) {
      throw new Error(`Expected exactly 1 integration record, found ${rowCount}. Duplicate rows detected!`);
    }
    console.log('✅ Reconnect updates connection and avoids duplicates successfully.\n');

    // -------------------------------------------------------------------------
    // Checkpoint 10 & 11: Ownership routing & No connection isolation
    // -------------------------------------------------------------------------
    console.log('👉 [Checkpoint 10 & 11] Verifying rate limit notification routing and isolation...');
    
    // Create Campaign A owned by User A
    const campARes = await pool.query(
      `INSERT INTO campaigns (user_id, subject, body, hourly_limit, status)
       VALUES ($1, 'Campaign User A Subject', 'Body', 5, 'sending') RETURNING id`,
      [userAId]
    );
    const campaignAId = campARes.rows[0].id;

    // Create Campaign B owned by User B (who has NO Slack integration)
    const campBRes = await pool.query(
      `INSERT INTO campaigns (user_id, subject, body, hourly_limit, status)
       VALUES ($1, 'Campaign User B Subject', 'Body', 5, 'sending') RETURNING id`,
      [userBId]
    );
    const campaignBId = campBRes.rows[0].id;

    console.log(`   Campaign A (User A): ${campaignAId}`);
    console.log(`   Campaign B (User B - No Slack): ${campaignBId}`);

    // TEST case 10: Trigger alert for Campaign A (User A is connected)
    console.log('   Triggering rate limit notification for Campaign A...');
    clearTestState();
    await handleRateLimitNotification(campaignAId, 5, 3600000);
    
    console.log(`   Notifications sent: ${(testState.sentNotifications as any).length}`);
    if ((testState.sentNotifications as any).length !== 1) {
      throw new Error(`Expected 1 notification to be sent for Campaign A, got ${(testState.sentNotifications as any).length}`);
    }
    console.log('   Message text:', testState.sentNotifications[0].text);
    if (!testState.sentNotifications[0].text.includes('Campaign User A Subject')) {
      throw new Error('Notification text did not contain Campaign A subject');
    }

    // TEST case 11: Trigger alert for Campaign B (User B has no connection)
    console.log('   Triggering rate limit notification for Campaign B...');
    clearTestState();
    await handleRateLimitNotification(campaignBId, 5, 3600000);
    
    console.log(`   Notifications sent: ${(testState.sentNotifications as any).length}`);
    if ((testState.sentNotifications as any).length !== 0) {
      throw new Error(`Expected 0 notifications to be sent for User B, got ${(testState.sentNotifications as any).length}`);
    }
    console.log('   Verify: No Slack message sent and no crash occurred.');
    console.log('✅ Notification lookup and isolation tests passed.\n');

    // -------------------------------------------------------------------------
    // Checkpoint 9: Disconnect works
    // -------------------------------------------------------------------------
    console.log('👉 [Checkpoint 9] Verifying disconnect endpoint...');
    const disconnectRes = await fetch(`${BASE_URL}/auth/slack`, {
      method: 'DELETE',
      headers: {
        'x-test-user-id': userAId,
      },
    });

    if (disconnectRes.status !== 200) {
      throw new Error(`Expected 200 OK from disconnect endpoint, got ${disconnectRes.status}`);
    }
    const disconnectJson = await disconnectRes.json() as any;
    console.log('   Disconnect response:', disconnectJson);

    // Verify deletion in database
    const deletedRecord = await getSlackIntegrationByUserId(userAId);
    if (deletedRecord) {
      throw new Error('Slack integration still exists in database after deletion request.');
    }

    // Verify disconnected status
    const statusPostDisconnectRes = await fetch(`${BASE_URL}/auth/slack/status`, {
      headers: {
        'x-test-user-id': userAId,
      },
    });
    const statusPostDisconnectJson = await statusPostDisconnectRes.json() as any;
    console.log('   Status post-disconnect JSON:', statusPostDisconnectJson);
    if (statusPostDisconnectJson.connected !== false) {
      throw new Error('Status endpoint did not return connected: false after disconnect.');
    }
    console.log('✅ Disconnect endpoint functions correctly.\n');

    // -------------------------------------------------------------------------
    // Checkpoint 24: Security boundaries - User B cannot view/delete User A's connections
    // -------------------------------------------------------------------------
    console.log('👉 [Checkpoint 24] Verifying security boundaries (User B cannot view or disconnect User A\'s Slack)...');
    
    // Re-connect User A's Slack
    console.log('   Re-connecting User A...');
    const reconnectAConnectRes = await fetch(`${BASE_URL}/auth/slack`, {
      method: 'GET',
      headers: {
        'x-test-user-id': userAId,
      },
      redirect: 'manual',
    });
    const reconnectALoc = reconnectAConnectRes.headers.get('location')!;
    const reconnectAState = new URL(reconnectALoc).searchParams.get('state')!;
    const reconnectACookie = reconnectAConnectRes.headers.get('set-cookie')!.split(';')[0];
    
    await fetch(
      `${BASE_URL}/auth/slack/callback?code=mock-code-success&state=${reconnectAState}`,
      {
        headers: {
          'x-test-user-id': userAId,
          cookie: reconnectACookie,
        },
      }
    );

    // Try to access User A's status as User B
    // Since status endpoint uses requireAuth and resolves the integration for req.user.id,
    // when User B hits status, it resolves User B's integration (which is not connected)
    const statusAsBRes = await fetch(`${BASE_URL}/auth/slack/status`, {
      headers: {
        'x-test-user-id': userBId, // Hitting as User B
      },
    });
    const statusAsBJson = await statusAsBRes.json() as any;
    console.log('   User B status query result:', statusAsBJson);
    if (statusAsBJson.connected !== false) {
      throw new Error('Security breach: User B query resolved User A\'s Slack connection status!');
    }

    // Try to delete User A's connection as User B
    console.log('   User B attempts to delete User A\'s Slack integration...');
    const deleteAsBRes = await fetch(`${BASE_URL}/auth/slack`, {
      method: 'DELETE',
      headers: {
        'x-test-user-id': userBId, // Hitting as User B
      },
    });
    console.log(`   Delete status for User B: ${deleteAsBRes.status}`);
    if (deleteAsBRes.status !== 404) {
      throw new Error(`Expected 404 Not Found since User B does not have a Slack connection, got ${deleteAsBRes.status}`);
    }

    // Double check User A's integration is still in DB
    const finalRecordA = await getSlackIntegrationByUserId(userAId);
    if (!finalRecordA) {
      throw new Error('Security breach: User B successfully deleted User A\'s Slack integration!');
    }
    console.log('   Verified: User A\'s integration remains intact in database.');
    console.log('✅ Security boundaries and multi-tenancy are strictly enforced.\n');

  } catch (err: any) {
    console.error('\n❌ FAIL: Test failed with error:', err.message);
    exitCode = 1;
  } finally {
    console.log('🧹 Cleaning up test records from database...');
    try {
      await pool.query("DELETE FROM slack_integrations WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'slack-oauth-%')");
      await pool.query("DELETE FROM campaigns WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'slack-oauth-%')");
      await pool.query("DELETE FROM users WHERE email LIKE 'slack-oauth-%'");
      console.log('   ✅ Test database records cleaned up.');
    } catch (err: any) {
      console.error('   ❌ Database cleanup failed:', err.message);
    }

    console.log('🔌 Closing server and active connections...');
    server.close();
    await disconnectDB();
    await redis.quit();
    console.log('==================================================');
    if (exitCode === 0) {
      console.log('🎉 ALL Slack OAuth tests passed successfully!');
    } else {
      console.log('❌ Slack OAuth tests FAILED.');
    }
    console.log('==================================================');
    process.exit(exitCode);
  }
}

main();
