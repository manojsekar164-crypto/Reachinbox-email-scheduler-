/**
 * src/scripts/testCsvAndForecastAccuracy.ts
 *
 * Dedicated verification suite for:
 *  - TASK A: CSV Import Reporting, diagnostics preservation, edge case handling.
 *  - TASK B: Delivery Forecast Accuracy, spacing vs hourly capacity, 1, 2, 100, 101 recipient boundary conditions.
 *
 * Invariants:
 *  - Zero production database mutations.
 *  - Zero email worker execution or BullMQ job enqueuing.
 *  - Zero real emails sent.
 */

import {
  parseRawContent,
  validateRecipients,
  calculateCapacityAndForecast,
  runPreflight,
} from '../services/preflightService';
import { preflightCampaignHandler } from '../controllers/preflightController';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  ❌ [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✅ [PASS] ${message}`);
}

async function runAllTests(): Promise<void> {
  console.log('==========================================================================');
  console.log('  CSV IMPORT REPORTING & CAMPAIGN DELIVERY FORECAST VERIFICATION');
  console.log('==========================================================================\n');

  let passedCount = 0;
  const countPass = (fn: () => void | Promise<void>) => async () => {
    await fn();
    passedCount++;
  };

  // Mock DB and Redis for forecast unit tests
  const mockDb: any = {
    query: async (sql: string, params: any[]) => {
      if (sql.includes('FROM senders')) {
        return {
          rows: [
            {
              id: 's-mock-1',
              email: 'sender@reachinbox.test',
              hourly_limit: 1000,
            },
          ],
        };
      }
      if (sql.includes('FROM campaigns')) {
        return {
          rows: [
            {
              id: 'c-mock-1',
              user_id: 'u-mock-1',
              sender_id: 's-mock-1',
              hourly_limit: 100,
            },
          ],
        };
      }
      if (sql.includes('FROM recipients')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const createMockRedis = (overrides: {
    campaignUsed?: number;
    senderUsed?: number;
    campaignTtl?: number;
    senderTtl?: number;
    lastSendWaitMs?: number;
  } = {}) => {
    const campaignUsed = overrides.campaignUsed ?? 0;
    const senderUsed = overrides.senderUsed ?? 0;
    const campaignTtl = overrides.campaignTtl ?? 3600;
    const senderTtl = overrides.senderTtl ?? 3600;
    const lastSendWaitMs = overrides.lastSendWaitMs ?? 0;

    return {
      get: async (key: string) => {
        if (key.includes('campaign')) return String(campaignUsed);
        if (key.includes('sender')) return String(senderUsed);
        if (key.includes('global')) return '0';
        return '0';
      },
      ttl: async (key: string) => {
        if (key.includes('campaign')) return campaignTtl;
        if (key.includes('sender')) return senderTtl;
        return 3600;
      },
      pttl: async (key: string) => {
        if (key.includes('campaign')) return campaignTtl * 1000;
        if (key.includes('sender')) return senderTtl * 1000;
        return 3600000;
      },
      eval: async (script: string, numKeys: number, ...args: any[]) => {
        return [1, lastSendWaitMs, 'ok', Date.now()];
      },
    } as any;
  };

  const mockQueue: any = {
    getJobCounts: async () => ({ waiting: 0, active: 0 }),
  };

  // =========================================================================
  // TASK A: CSV IMPORT REPORTING & FIXTURE VERIFICATION
  // =========================================================================
  console.log('--------------------------------------------------------------------------');
  console.log('TEST SUITE 1: Task A - Supplied CSV Fixture Reporting');
  console.log('--------------------------------------------------------------------------');

  const fixtureCsv = [
    'email,name',
    'test-inbox-1@example.com,Test Recipient One',
    'test-inbox-2@example.com,Test Recipient Two',
    'test-inbox-1@example.com,Duplicate Recipient',
    'invalid-email,Invalid Recipient',
  ].join('\n');

  const parsedFixture = parseRawContent(fixtureCsv);
  assert(parsedFixture.headerFound === true, 'Header correctly identified in supplied fixture');
  assert(parsedFixture.rows.length === 4, 'Total data rows parsed equals exactly 4');

  const valFixture = await validateRecipients({ userId: 'u-mock-1', rawContent: fixtureCsv }, mockDb);
  assert(valFixture.counts.total_rows === 4, 'Fixture total data rows read (excluding header) is 4');
  assert(valFixture.counts.valid_count === 2, 'Fixture accepted unique recipients count is 2');
  assert(valFixture.counts.invalid_count === 1, 'Fixture invalid email rows rejected count is 1');
  assert(valFixture.counts.duplicate_count === 1, 'Fixture duplicate rows removed count is 1');
  assert(valFixture.valid.length === 2, 'Valid array contains exactly 2 recipients');
  assert(valFixture.valid[0]?.email === 'test-inbox-1@example.com', 'Recipient 1 is test-inbox-1@example.com');
  assert(valFixture.valid[1]?.email === 'test-inbox-2@example.com', 'Recipient 2 is test-inbox-2@example.com');
  assert(valFixture.invalid.length === 1, 'Invalid array contains exactly 1 entry');
  assert(valFixture.invalid[0]?.row === 5, 'Invalid recipient identified at row 5');
  assert(valFixture.invalid[0]?.email === 'invalid-email', 'Invalid email is invalid-email');
  assert(valFixture.invalid[0]?.reason.includes('format'), 'Informative reason provided for invalid syntax');
  assert(valFixture.duplicates.length === 1, 'Duplicate array contains exactly 1 entry');
  assert(valFixture.duplicates[0]?.row === 4, 'Duplicate recipient identified at row 4');
  assert(valFixture.duplicates[0]?.email === 'test-inbox-1@example.com', 'Duplicate email normalized to test-inbox-1@example.com');
  assert(valFixture.duplicates[0]?.reason.includes('Duplicate'), 'Reason indicates duplicate within upload');

  // =========================================================================
  // TASK A: CSV EDGE CASES
  // =========================================================================
  console.log('\n--------------------------------------------------------------------------');
  console.log('TEST SUITE 2: Task A - CSV Edge Cases');
  console.log('--------------------------------------------------------------------------');

  // 1. Empty rows
  const csvWithEmptyRows = '\nemail,name\n\nuser1@example.com,User One\n\n\nuser2@example.com,User Two\n\n';
  const valEmptyRows = await validateRecipients({ userId: 'u-mock-1', rawContent: csvWithEmptyRows }, mockDb);
  assert(valEmptyRows.counts.total_rows === 2, 'Empty lines between and around rows are safely ignored');
  assert(valEmptyRows.counts.valid_count === 2, '2 valid recipients found despite empty lines');

  // 2. Missing email column
  const csvMissingEmailCol = 'name,age,city\nJohn Doe,30,New York\nJane Smith,25,Chicago';
  const valMissingEmail = await validateRecipients({ userId: 'u-mock-1', rawContent: csvMissingEmailCol }, mockDb);
  assert(valMissingEmail.errors.length > 0, 'Missing email column in CSV header triggers error');
  assert(valMissingEmail.errors[0]?.includes('Missing required email column'), 'Error message clearly specifies missing email column');

  // 3. Invalid syntax rows
  const csvBadSyntax = 'email,name\ngood@example.com,Good\nbad-syntax,Bad1\n@no-user.com,Bad2\nno-tld@domain,Bad3';
  const valBadSyntax = await validateRecipients({ userId: 'u-mock-1', rawContent: csvBadSyntax }, mockDb);
  assert(valBadSyntax.counts.total_rows === 4, 'Total rows equals 4 for syntax test');
  assert(valBadSyntax.counts.valid_count === 1, 'Only 1 valid email accepted');
  assert(valBadSyntax.counts.invalid_count === 3, '3 invalid syntax rows rejected');

  // 4. Duplicate addresses and case differences
  const csvCaseDups = 'email,name\nALICE@EXAMPLE.COM,Alice\nalice@example.com,Alice Lower\nAlice@Example.Com,Alice Mixed';
  const valCaseDups = await validateRecipients({ userId: 'u-mock-1', rawContent: csvCaseDups }, mockDb);
  assert(valCaseDups.counts.valid_count === 1, 'Case difference deduplicated into 1 accepted recipient');
  assert(valCaseDups.counts.duplicate_count === 2, '2 case variants flagged as duplicates');

  // 5. Whitespace around email and name
  const csvWhitespace = '  email  ,  name  \n   bob@example.com   ,   Bob Smith   ';
  const valWhitespace = await validateRecipients({ userId: 'u-mock-1', rawContent: csvWhitespace }, mockDb);
  assert(valWhitespace.counts.valid_count === 1, 'Whitespace around header and cells trimmed cleanly');
  assert(valWhitespace.valid[0]?.email === 'bob@example.com', 'Email trimmed to lowercase without whitespace');
  assert(valWhitespace.valid[0]?.name === 'Bob Smith', 'Name trimmed without extra whitespace');

  // 6. Optional name column (only email column)
  const csvOnlyEmail = 'email\nsolo1@example.com\nsolo2@example.com';
  const valOnlyEmail = await validateRecipients({ userId: 'u-mock-1', rawContent: csvOnlyEmail }, mockDb);
  assert(valOnlyEmail.counts.total_rows === 2, 'CSV with only email column parsed 2 rows');
  assert(valOnlyEmail.counts.valid_count === 2, '2 valid recipients parsed without name column');
  assert(valOnlyEmail.valid[0]?.name === undefined, 'Name is undefined when column is omitted');

  // 7. Empty file
  const valEmptyFile = await validateRecipients({ userId: 'u-mock-1', rawContent: '' }, mockDb);
  assert(valEmptyFile.errors.length > 0, 'Empty file returns error');
  assert(valEmptyFile.errors[0]?.includes('empty'), 'Error states file is empty');

  // 8. Malformed CSV with null byte
  const valNullByte = await validateRecipients({ userId: 'u-mock-1', rawContent: 'email,name\0null@test.com' }, mockDb);
  assert(valNullByte.errors.length > 0, 'Binary null byte detected safely');
  assert(valNullByte.errors[0]?.includes('binary or null byte'), 'Error specifies binary or null byte');

  // =========================================================================
  // TASK A: PRESERVE IMPORT DIAGNOSTICS WITH ALREADY-FILTERED RECIPIENTS
  // =========================================================================
  console.log('\n--------------------------------------------------------------------------');
  console.log('TEST SUITE 3: Task A - Preserving CSV Diagnostics on Filtered Submission');
  console.log('--------------------------------------------------------------------------');

  // When frontend submits already-filtered recipients (2) with importDiagnostics from CSV
  const filteredSubmission = [
    { email: 'test-inbox-1@example.com', name: 'Test Recipient One' },
    { email: 'test-inbox-2@example.com', name: 'Test Recipient Two' },
  ];
  const importDiagnosticsPayload = {
    total_rows: 4,
    valid_count: 2,
    invalid_count: 1,
    duplicate_count: 1,
    invalid: [{ row: 5, email: 'invalid-email', reason: 'Invalid email address format' }],
    duplicates: [{ row: 4, email: 'test-inbox-1@example.com', reason: 'Duplicate email address within uploaded file' }],
  };

  const valWithDiagnostics = await validateRecipients(
    {
      userId: 'u-mock-1',
      recipients: filteredSubmission,
      importDiagnostics: importDiagnosticsPayload,
    },
    mockDb
  );

  assert(valWithDiagnostics.counts.total_rows === 4, 'Preflight preserves total rows (4) from import diagnostics');
  assert(valWithDiagnostics.counts.valid_count === 2, 'Preflight reports 2 valid recipients');
  assert(valWithDiagnostics.counts.invalid_count === 1, 'Preflight does not lose invalid syntax count (1)');
  assert(valWithDiagnostics.counts.duplicate_count === 1, 'Preflight does not lose duplicate count (1)');
  assert(valWithDiagnostics.invalid.length === 1, 'Preflight preserves invalid rows details');
  assert(valWithDiagnostics.invalid[0]?.row === 5, 'Invalid row preserved at row 5');
  assert(valWithDiagnostics.duplicates.length === 1, 'Preflight preserves duplicate rows details');
  assert(valWithDiagnostics.duplicates[0]?.row === 4, 'Duplicate row preserved at row 4');

  // Test full runPreflight with importDiagnostics
  const fullPreflightRes = await runPreflight(
    {
      userId: 'u-mock-1',
      senderId: 's-mock-1',
      hourlyLimit: 100,
      recipients: filteredSubmission,
      importDiagnostics: importDiagnosticsPayload,
    },
    mockDb,
    createMockRedis(),
    mockQueue
  );

  assert(fullPreflightRes.success === true, 'Preflight execution succeeds');
  assert(fullPreflightRes.validation.counts.total_rows === 4, 'RunPreflight preserves total data rows: 4');
  assert(fullPreflightRes.validation.counts.valid_count === 2, 'RunPreflight valid count: 2');
  assert(fullPreflightRes.validation.counts.invalid_count === 1, 'RunPreflight invalid count: 1');
  assert(fullPreflightRes.validation.counts.duplicate_count === 1, 'RunPreflight duplicate count: 1');
  assert(fullPreflightRes.forecast.recipient_count === 2, 'Forecast recipient count reflects valid recipients: 2');
  assert(fullPreflightRes.forecast.estimated_duration_seconds === 2, 'Forecast duration for 2 recipients is 2s');
  assert(
    Boolean(fullPreflightRes.forecast.explanation && fullPreflightRes.forecast.explanation.includes('inter-send spacing')),
    'Forecast explanation explains pacing constraint vs hourly limit'
  );

  // =========================================================================
  // TASK B: DELIVERY FORECAST ACCURACY & BOUNDARY CONDITIONS
  // =========================================================================
  console.log('\n--------------------------------------------------------------------------');
  console.log('TEST SUITE 4: Task B - Forecast Accuracy (1, 2, 100, 101 Recipients)');
  console.log('--------------------------------------------------------------------------');

  // Scenario 1: 0 recipients
  const fc0 = await calculateCapacityAndForecast(
    {
      userId: 'u-mock-1',
      senderId: 's-mock-1',
      hourlyLimit: 100,
      recipientCount: 0,
    },
    mockDb,
    createMockRedis(),
    mockQueue
  );
  assert(fc0.forecast.recipient_count === 0, 'N = 0: recipient count is 0');
  assert(fc0.forecast.estimated_duration_seconds === 0, 'N = 0: duration is 0 seconds');
  assert(fc0.forecast.explanation?.includes('0 recipients'), 'N = 0: explanation notes 0 recipients');

  // Scenario 2: 1 recipient at 100/hr limit with 2000ms spacing
  const fc1 = await calculateCapacityAndForecast(
    {
      userId: 'u-mock-1',
      senderId: 's-mock-1',
      hourlyLimit: 100,
      recipientCount: 1,
    },
    mockDb,
    createMockRedis(),
    mockQueue
  );
  assert(fc1.forecast.recipient_count === 1, 'N = 1: recipient count is 1');
  assert(fc1.forecast.estimated_duration_seconds === 0, 'N = 1: duration is 0 seconds (first send is immediate)');
  assert(fc1.capacity.effective_hourly_rate === 100, 'N = 1: effective hourly rate is 100 emails/hr');
  assert(fc1.forecast.explanation?.includes('Single recipient'), 'N = 1: explanation notes single recipient immediate send');

  // Scenario 3: 2 recipients at 100/hr limit with 2000ms spacing
  const fc2 = await calculateCapacityAndForecast(
    {
      userId: 'u-mock-1',
      senderId: 's-mock-1',
      hourlyLimit: 100,
      recipientCount: 2,
    },
    mockDb,
    createMockRedis(),
    mockQueue
  );
  assert(fc2.forecast.recipient_count === 2, 'N = 2: recipient count is 2');
  assert(fc2.forecast.estimated_duration_seconds === 2, 'N = 2: duration is exactly 2 seconds ((2 - 1) * 2000ms)');
  assert(fc2.capacity.effective_hourly_rate === 100, 'N = 2: effective hourly rate is 100 emails/hr');
  assert(fc2.capacity.current_hour_remaining === 100, 'N = 2: 100 sends remaining in window');
  assert(
    Boolean(fc2.forecast.explanation && fc2.forecast.explanation.includes('governed by') && fc2.forecast.explanation.includes('inter-send spacing')),
    'N = 2: explanation clarifies duration is governed by 2000ms inter-send spacing constraint'
  );
  assert(
    Boolean(fc2.forecast.assumptions.some((a) => a.includes('Inter-send spacing of 2000ms'))),
    'N = 2: assumptions explicitly list 2000ms inter-send spacing'
  );
  assert(
    Boolean(fc2.forecast.assumptions.some((a) => a.includes('Hourly limit of 100 emails/hr'))),
    'N = 2: assumptions explicitly list 100 emails/hr quota ceiling'
  );

  // Scenario 4: 100 recipients at 100/hr limit with 2000ms spacing
  const fc100 = await calculateCapacityAndForecast(
    {
      userId: 'u-mock-1',
      senderId: 's-mock-1',
      hourlyLimit: 100,
      recipientCount: 100,
    },
    mockDb,
    createMockRedis(),
    mockQueue
  );
  assert(fc100.forecast.recipient_count === 100, 'N = 100: recipient count is 100');
  // (100 - 1) * 2000ms = 198000ms = 198 seconds (3 minutes 18 seconds)
  assert(fc100.forecast.estimated_duration_seconds === 198, 'N = 100: duration is 198 seconds ((100 - 1) * 2s)');
  assert(fc100.forecast.warnings.length === 0, 'N = 100: no spillover warnings because 100 fits within remaining quota');
  assert(
    Boolean(fc100.forecast.explanation && fc100.forecast.explanation.includes('All 100 recipient(s) fit within current hour window')),
    'N = 100: explanation confirms all 100 fit within window'
  );

  // Scenario 5: 101 recipients at 100/hr limit with 2000ms spacing (spillover to next window)
  const fc101 = await calculateCapacityAndForecast(
    {
      userId: 'u-mock-1',
      senderId: 's-mock-1',
      hourlyLimit: 100,
      recipientCount: 101,
    },
    mockDb,
    createMockRedis({ campaignTtl: 3600 }),
    mockQueue
  );
  assert(fc101.forecast.recipient_count === 101, 'N = 101: recipient count is 101');
  // 100 emails sent in first hour (198s); 101st email waits for 3600s window reset.
  // durationMs = max(spacingDurationMs, rateDurationMs) = max(200s, 3600000ms) = 3600s
  assert(fc101.forecast.estimated_duration_seconds === 3600, 'N = 101: duration is 3600 seconds due to hourly quota spillover');
  assert(fc101.forecast.warnings.length === 1, 'N = 101: warning generated for quota spillover');
  assert(
    fc101.forecast.warnings[0]?.includes('Recipient count (101) exceeds current hour remaining capacity (100)'),
    'N = 101: warning clearly indicates 101 exceeds 100 remaining capacity'
  );
  assert(
    !fc101.forecast.warnings[0]?.includes('limit limit'),
    'N = 101: warning does not duplicate "limit limit"'
  );
  assert(
    Boolean(fc101.forecast.explanation && fc101.forecast.explanation.includes('future window')),
    'N = 101: explanation details that remaining email dispatches after window reset'
  );

  // =========================================================================
  // TASK B: ADDITIONAL BOUNDARY CONDITIONS
  // =========================================================================
  console.log('\n--------------------------------------------------------------------------');
  console.log('TEST SUITE 5: Task B - Additional Rate-Limit Boundary Conditions');
  console.log('--------------------------------------------------------------------------');

  // Boundary 1: Quota Already Exhausted (0 remaining)
  const fcExhausted = await calculateCapacityAndForecast(
    {
      userId: 'u-mock-1',
      campaignId: 'c-mock-1',
      senderId: 's-mock-1',
      hourlyLimit: 100,
      recipientCount: 5,
    },
    mockDb,
    createMockRedis({ campaignUsed: 100, campaignTtl: 1800 }),
    mockQueue
  );
  assert(fcExhausted.capacity.current_hour_remaining === 0, 'Exhausted: current hour remaining is 0');
  // Must wait 1800s (30m) TTL reset + (5 - 1) * 2s spacing = 1800s + 8s = 1808s
  assert(fcExhausted.forecast.estimated_duration_seconds === 1808, 'Exhausted: duration accounts for 1800s reset wait + spacing');
  assert(
    fcExhausted.forecast.warnings[0]?.includes('Current hourly rate limit is exhausted'),
    'Exhausted: warning notes rate limit is exhausted'
  );

  // Boundary 2: Partial Remaining Capacity (50 used of 100, batch of 60)
  const fcPartial = await calculateCapacityAndForecast(
    {
      userId: 'u-mock-1',
      campaignId: 'c-mock-1',
      senderId: 's-mock-1',
      hourlyLimit: 100,
      recipientCount: 60,
    },
    mockDb,
    createMockRedis({ campaignUsed: 50, campaignTtl: 2400 }),
    mockQueue
  );
  assert(fcPartial.capacity.current_hour_remaining === 50, 'Partial: 50 remaining of 100');
  // First 50 sent in hour 1. Remaining 10 spill over to hour 2.
  // rateDurationMs = 2400s (reset wait) + 0 full hours + (10 - 1) * 2s = 2400s + 18s = 2418s
  assert(fcPartial.forecast.estimated_duration_seconds === 2418, 'Partial: duration is 2418s (2400s reset wait + 18s spacing for spillover)');
  assert(fcPartial.forecast.warnings.length === 1, 'Partial: warning generated for spillover');

  // Boundary 3: HTTP Controller preflightCampaignHandler accepts import_diagnostics
  let responseStatusCode = 0;
  let responseData: any = null;
  const mockReq: any = {
    user: { id: '68c8099d-2f67-4ad7-b22a-12973e7ecfe5' },
    params: {},
    queue: mockQueue,
    body: {
      sender_id: 'ee5fb1c2-3bed-4c20-9b65-dc332203cb89',
      hourly_limit: 100,
      recipients: [
        { email: 'test-inbox-1@example.com', name: 'Test Recipient One' },
        { email: 'test-inbox-2@example.com', name: 'Test Recipient Two' },
      ],
      import_diagnostics: {
        total_rows: 4,
        valid_count: 2,
        invalid_count: 1,
        duplicate_count: 1,
        invalid: [{ row: 5, email: 'invalid-email', reason: 'Invalid email address format' }],
        duplicates: [{ row: 4, email: 'test-inbox-1@example.com', reason: 'Duplicate email address within uploaded file' }],
      },
    },
  };
  const mockRes: any = {
    status: (code: number) => {
      responseStatusCode = code;
      return mockRes;
    },
    json: (data: any) => {
      responseData = data;
      return mockRes;
    },
  };
  const mockNext = (err: any) => {
    if (err) throw err;
  };

  await preflightCampaignHandler(mockReq, mockRes, mockNext);
  assert(responseStatusCode === 200, 'HTTP Controller returns 200 OK');
  assert(responseData?.validation?.counts?.total_rows === 4, 'HTTP Controller response preserves total_rows: 4');
  assert(responseData?.validation?.counts?.valid_count === 2, 'HTTP Controller response valid_count: 2');
  assert(responseData?.validation?.counts?.invalid_count === 1, 'HTTP Controller response invalid_count: 1');
  assert(responseData?.validation?.counts?.duplicate_count === 1, 'HTTP Controller response duplicate_count: 1');
  assert(responseData?.forecast?.recipient_count === 2, 'HTTP Controller forecast recipient count: 2');
  assert(responseData?.forecast?.estimated_duration_seconds === 2, 'HTTP Controller forecast duration: 2s');
  assert(Boolean(responseData?.forecast?.explanation), 'HTTP Controller forecast contains explanation');

  console.log('\n==========================================================================');
  console.log('  ALL CSV IMPORT & DELIVERY FORECAST TESTS PASSED SUCCESSFULLY');
  console.log('==========================================================================\n');
}

runAllTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ TEST SUITE FAILED:', err);
    process.exit(1);
  });
