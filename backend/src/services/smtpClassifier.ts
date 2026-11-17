/**
 * src/services/smtpClassifier.ts
 *
 * Conservative SMTP Delivery Outcome Classifier.
 *
 * Implements strict classification of all SMTP responses and network errors into
 * five conservative categories:
 *  1. confirmed_acceptance:   SMTP 2xx acceptance acknowledgment.
 *  2. permanent_rejection:     SMTP 5xx or authentication failure (non-retryable).
 *  3. transient_rejection:     SMTP 4xx rejection (safe to retry after delay).
 *  4. connection_failure:       TCP/TLS network failure confirmed BEFORE DATA transmission (safe to retry).
 *  5. ambiguous_outcome:       Connection loss or timeout during/after message DATA transmission (in-doubt, NEVER retried).
 */

export type SmtpOutcomeCategory =
  | 'confirmed_acceptance'
  | 'permanent_rejection'
  | 'transient_rejection'
  | 'connection_failure'
  | 'ambiguous_outcome';

export interface SmtpClassificationResult {
  category: SmtpOutcomeCategory;
  isRetryable: boolean;
  responseCode: string | null;
  enhancedStatusCode: string | null;
  messageId: string | null;
  responseMessage: string | null;
  errorDetail: string;
}

/**
 * Classifies an SMTP delivery outcome or error into one of five conservative categories.
 *
 * Invariants:
 *  - Only retries failures confirmed to have occurred before message acceptance.
 *  - Treats connection drops or timeouts during/after DATA transmission as ambiguous (unknown).
 *  - Never automatically retries ambiguous outcomes.
 *  - Never fabricates success, message IDs, or status codes.
 */
export function classifySmtpOutcome(
  error: any,
  context?: { dataSent?: boolean; command?: string }
): SmtpClassificationResult {
  // If no error is present, outcome is confirmed acceptance
  if (!error) {
    return {
      category: 'confirmed_acceptance',
      isRetryable: false,
      responseCode: '250',
      enhancedStatusCode: '2.0.0',
      messageId: null,
      responseMessage: 'OK',
      errorDetail: 'Success',
    };
  }

  const rawMsg = error.message || '';
  const lowerMsg = rawMsg.toLowerCase();
  const code = (error.code || '').toUpperCase();
  const rawResponse = String(error.response || '');
  const command = (error.command || context?.command || '').toUpperCase();

  // Extract 3-digit SMTP code (e.g. 550, 451, 535, 250)
  let responseCode: string | null = null;
  if (error.responseCode && Number(error.responseCode) >= 200 && Number(error.responseCode) <= 599) {
    responseCode = String(error.responseCode);
  } else {
    const match = rawResponse.match(/\b([245]\d{2})\b/) || rawMsg.match(/\b([245]\d{2})\b/);
    if (match) {
      responseCode = match[1];
    }
  }

  // Extract enhanced status code (e.g. 5.1.1, 4.3.0, 2.0.0, 5.7.8)
  const enhancedMatch =
    rawResponse.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/) ||
    rawMsg.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/);
  const enhancedStatusCode = enhancedMatch ? enhancedMatch[1] : null;

  // 1. Authentication failures (EAUTH, 535, or invalid credentials text)
  if (
    code === 'EAUTH' ||
    responseCode === '535' ||
    enhancedStatusCode === '5.7.8' ||
    lowerMsg.includes('invalid login') ||
    lowerMsg.includes('authentication failed') ||
    lowerMsg.includes('credentials invalid') ||
    lowerMsg.includes('bad username / password')
  ) {
    return {
      category: 'permanent_rejection',
      isRetryable: false,
      responseCode: responseCode || '535',
      enhancedStatusCode: enhancedStatusCode || '5.7.8',
      messageId: null,
      responseMessage: rawResponse || rawMsg,
      errorDetail: `Authentication failed: ${rawMsg}`,
    };
  }

  // 2. Explicit SMTP 5xx permanent rejection (e.g. 550 User unknown, 554 Transaction failed, 501 Syntax error)
  if (responseCode && responseCode.startsWith('5')) {
    return {
      category: 'permanent_rejection',
      isRetryable: false,
      responseCode,
      enhancedStatusCode,
      messageId: null,
      responseMessage: rawResponse || rawMsg,
      errorDetail: `Permanent SMTP rejection (${responseCode}): ${rawMsg}`,
    };
  }

  // 3. Explicit SMTP 4xx transient rejection (e.g. 451 Mailbox busy, 421 Service unavailable, 452 Quota)
  if (responseCode && responseCode.startsWith('4')) {
    return {
      category: 'transient_rejection',
      isRetryable: true,
      responseCode,
      enhancedStatusCode,
      messageId: null,
      responseMessage: rawResponse || rawMsg,
      errorDetail: `Transient SMTP rejection (${responseCode}): ${rawMsg}`,
    };
  }

  // 4. Ambiguous SMTP outcome (Connection dropped / timeout during or after message DATA transmission)
  const isPostData =
    context?.dataSent === true ||
    error.dataSent === true ||
    error.isUncertain === true ||
    command === 'DATA' ||
    command === 'DATA END' ||
    command === 'MESSAGE' ||
    lowerMsg.includes('waiting for smtp 250') ||
    lowerMsg.includes('after data') ||
    lowerMsg.includes('during data') ||
    lowerMsg.includes('uncertain');

  if (isPostData) {
    return {
      category: 'ambiguous_outcome',
      isRetryable: false,
      responseCode: responseCode || code || 'ETIMEDOUT',
      enhancedStatusCode: null,
      messageId: null,
      responseMessage: rawResponse || null,
      errorDetail: `Ambiguous SMTP outcome (connection lost during/after message DATA transmission): ${rawMsg}`,
    };
  }

  // 5. Connection failure confirmed before message acceptance
  const isPreDataCommand =
    command === 'CONN' ||
    command === 'HELO' ||
    command === 'EHLO' ||
    command === 'AUTH' ||
    command === 'MAIL FROM' ||
    command === 'RCPT TO';

  const isNetworkConnectCode = [
    'ECONNREFUSED',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EAI_AGAIN',
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
  ].includes(code);

  const isConnectSyscall =
    error.syscall === 'connect' ||
    lowerMsg.includes('connect econnrefused') ||
    lowerMsg.includes('getaddrinfo enotfound');

  if (
    isNetworkConnectCode ||
    isConnectSyscall ||
    (isPreDataCommand &&
      (code === 'ECONNRESET' ||
        code === 'EPIPE' ||
        code === 'ETIMEDOUT' ||
        code === 'ECONNECTION' ||
        lowerMsg.includes('socket hung up') ||
        lowerMsg.includes('connection lost') ||
        lowerMsg.includes('connection closed') ||
        lowerMsg.includes('closed unexpectedly')))
  ) {
    return {
      category: 'connection_failure',
      isRetryable: true,
      responseCode: code || 'ECONNREFUSED',
      enhancedStatusCode: null,
      messageId: null,
      responseMessage: null,
      errorDetail: `Connection failure before message acceptance (${command || code || 'connect'}): ${rawMsg}`,
    };
  }

  // 6. Conservative fallback for generic timeouts, resets, or unexpected connection closures without stage evidence
  const uncertainNetworkCodes = ['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EPIPE', 'ECONNECTION'];
  if (
    uncertainNetworkCodes.includes(code) ||
    lowerMsg.includes('timeout') ||
    lowerMsg.includes('socket hung up') ||
    lowerMsg.includes('connection reset') ||
    lowerMsg.includes('connection closed') ||
    lowerMsg.includes('closed unexpectedly')
  ) {
    return {
      category: 'ambiguous_outcome',
      isRetryable: false,
      responseCode: code || 'ECONNRESET',
      enhancedStatusCode: null,
      messageId: null,
      responseMessage: null,
      errorDetail: `Ambiguous network outcome without verified pre-DATA stage: ${rawMsg}`,
    };
  }

  // 7. Uncategorized failure -> treat conservatively as non-retryable permanent rejection
  return {
    category: 'permanent_rejection',
    isRetryable: false,
    responseCode: responseCode || 'EUNKNOWN',
    enhancedStatusCode: null,
    messageId: null,
    responseMessage: rawResponse || null,
    errorDetail: `Uncategorized SMTP failure: ${rawMsg}`,
  };
}

/**
 * Checks if an error represents an uncertain outcome (in-doubt delivery).
 * Re-uses the classifier category for consistency.
 */
export function isUncertainSmtpError(error: any): boolean {
  if (!error) return false;
  const classification = classifySmtpOutcome(error);
  return classification.category === 'ambiguous_outcome';
}
