/**
 * backend/src/scripts/testGeminiConnectivity.ts
 *
 * Safe Gemini Connectivity & Error Classification Verification Suite.
 *
 * Verifies:
 *  1. Default model resolution and model name prefix normalization.
 *  2. Safe live connectivity to Google Gemini API (gemini-3.6-flash) with a harmless prompt.
 *  3. Non-empty response handling.
 *  4. Error classification for 404 (Model Not Found / Obsolete ID).
 *  5. Error classification for 400/401/403 (Invalid API Key / Unauthorized).
 *  6. Zero API key leakage in logs, headers, or exception messages.
 */

import dns from 'dns';
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (_) {}

import dotenv from 'dotenv';
import path from 'path';

// Load environment from backend/.env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { GeminiProvider } from '../services/llmProvider';
import {
  CopilotConfigError,
  CopilotProviderAuthError,
  CopilotProviderError,
  CopilotRateLimitError,
} from '../types/copilot.types';

const SEP = '='.repeat(70);
const SUB_SEP = '-'.repeat(70);

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string): void {
  if (condition) {
    console.log(`  [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${testName}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

async function runGeminiConnectivitySuite(): Promise<void> {
  console.log('\n' + SEP);
  console.log('  GEMINI CONNECTIVITY & ERROR CLASSIFICATION AUDIT');
  console.log(SEP + '\n');

  const apiKey = process.env['GEMINI_API_KEY'];
  const configuredModel = process.env['GEMINI_MODEL'] || 'gemini-3.6-flash';

  // -------------------------------------------------------------------------
  // TEST 1: Model Name Resolution & Normalization
  // -------------------------------------------------------------------------
  console.log(SUB_SEP);
  console.log('TEST 1: Model Name Resolution & Normalization');
  console.log(SUB_SEP);

  const defaultProvider = new GeminiProvider(apiKey || 'test-key');
  assert(
    defaultProvider.modelName === configuredModel.replace(/^models\//i, '').trim(),
    `Default model correctly resolves to "${defaultProvider.modelName}"`
  );

  const prefixedProvider = new GeminiProvider('test-key', 'models/gemini-3.6-flash');
  assert(
    prefixedProvider.modelName === 'gemini-3.6-flash',
    'Leading "models/" prefix is cleanly stripped from modelName'
  );

  const trimmedProvider = new GeminiProvider('test-key', '  gemini-3.6-flash  ');
  assert(
    trimmedProvider.modelName === 'gemini-3.6-flash',
    'Whitespace around modelName is trimmed'
  );

  // -------------------------------------------------------------------------
  // TEST 2: Unconfigured Provider Throws 503
  // -------------------------------------------------------------------------
  console.log('\n' + SUB_SEP);
  console.log('TEST 2: Unconfigured Provider Safety');
  console.log(SUB_SEP);

  const emptyProvider = new GeminiProvider('');
  assert(!emptyProvider.isConfigured(), 'Empty API key reports isConfigured() === false');

  let caughtUnconfigured = false;
  try {
    await emptyProvider.generateCompletion([{ role: 'user', content: 'Ping' }]);
  } catch (err: any) {
    if (err instanceof CopilotConfigError && err.statusCode === 503) {
      caughtUnconfigured = true;
    }
  }
  assert(caughtUnconfigured, 'Unconfigured GeminiProvider throws CopilotConfigError (503)');

  // -------------------------------------------------------------------------
  // TEST 3: Safe Live Connectivity (Harmless Prompt)
  // -------------------------------------------------------------------------
  console.log('\n' + SUB_SEP);
  console.log('TEST 3: Safe Live Connectivity & Response Verification');
  console.log(SUB_SEP);

  if (!apiKey || apiKey.trim().length === 0) {
    console.warn('  [SKIP] GEMINI_API_KEY is not configured in backend/.env.');
  } else {
    const liveProvider = new GeminiProvider(apiKey);
    console.log(`  Target Model: ${liveProvider.modelName}`);

    try {
      const response = await liveProvider.generateCompletion(
        [{ role: 'user', content: 'Respond with exactly: PONG' }],
        { timeoutMs: 90000, maxTokens: 50 }
      );

      assert(typeof response === 'string', 'API response is a string');
      assert(response.trim().length > 0, 'API returned a non-empty response');
      assert(
        !response.includes(apiKey),
        'Zero API key leakage in response payload'
      );
      console.log(`  [INFO] Harmless live test response received (${response.trim().length} chars). Status: 200 OK`);
    } catch (err: any) {
      assert(false, 'Live Gemini request succeeded without error', err.message);
    }

    // Small spacing to respect project RPM limits
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // -------------------------------------------------------------------------
  // TEST 4: 404 Model Not Found Error Classification
  // -------------------------------------------------------------------------
  console.log('\n' + SUB_SEP);
  console.log('TEST 4: 404 Model Not Found Error Classification');
  console.log(SUB_SEP);

  if (apiKey && apiKey.trim().length > 0) {
    const obsoleteModelProvider = new GeminiProvider(apiKey, 'gemini-nonexistent-model-xyz-12345');
    let caught404 = false;
    let messageSafe = false;

    let errCaught: any = null;
    try {
      await obsoleteModelProvider.generateCompletion(
        [{ role: 'user', content: 'Hello' }],
        { timeoutMs: 10000 }
      );
    } catch (err: any) {
      errCaught = err;
      if (err instanceof CopilotProviderError && err.statusCode === 404) {
        caught404 = true;
        const hasKey = apiKey ? err.message.includes(apiKey) : false;
        const has404 = err.message.includes('404');
        messageSafe = !hasKey && has404;
      }
    }
    assert(caught404, 'Invalid model throws CopilotProviderError with statusCode === 404', `Got: ${errCaught?.constructor?.name} statusCode: ${errCaught?.statusCode}`);
    assert(messageSafe, '404 error message masks API key and explains model not found', `Message: ${errCaught?.message}`);
  } else {
    console.log('  [SKIP] Live API key required for real 404 classification test');
  }

  // -------------------------------------------------------------------------
  // TEST 5: Bad Credentials Authentication Error Classification (400/403/401)
  // -------------------------------------------------------------------------
  console.log('\n' + SUB_SEP);
  console.log('TEST 5: Bad Credentials Error Classification');
  console.log(SUB_SEP);

  const fakeKey = 'AIzaSyFakeKeyInvalidTesting1234567890';
  const badKeyProvider = new GeminiProvider(fakeKey, 'gemini-3.6-flash');
  let caughtAuthError = false;
  let authMsgSafe = false;

  try {
    await badKeyProvider.generateCompletion(
      [{ role: 'user', content: 'Hello' }],
      { timeoutMs: 10000 }
    );
  } catch (err: any) {
    if (
      err instanceof CopilotProviderAuthError ||
      (err instanceof CopilotProviderError && (err.statusCode === 400 || err.statusCode === 403 || err.statusCode === 401))
    ) {
      caughtAuthError = true;
      authMsgSafe = !err.message.includes(fakeKey);
    }
  }
  assert(caughtAuthError, 'Invalid credentials properly classified as authentication/authorization error');
  assert(authMsgSafe, 'Authentication error scrubbed credential from exception message');

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('\n' + SEP);
  console.log(`  GEMINI SUITE COMPLETE: ${passed} passed, ${failed} failed`);
  console.log(SEP + '\n');

  if (failed > 0) {
    process.exitCode = 1;
  }
}

runGeminiConnectivitySuite().catch((err) => {
  console.error('Fatal error in Gemini test suite:', err);
  process.exitCode = 1;
});
