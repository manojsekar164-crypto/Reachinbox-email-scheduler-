/**
 * src/services/llmProvider.ts
 *
 * Real LLM Provider abstraction supporting OpenAI, Anthropic, Google Gemini,
 * and a deterministic Mock provider for automated test suites.
 * Uses Node native fetch with strict timeouts, bounded context, and safe error handling.
 */

import dns from 'dns';
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (_) {}

import {
  ILLMProvider,
  LLMMessage,
  LLMProviderOptions,
  LLMProviderType,
  CopilotConfigError,
  CopilotProviderAuthError,
  CopilotRateLimitError,
  CopilotTimeoutError,
  CopilotProviderError,
} from '../types/copilot.types';

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_TOKENS = 1024;

function sanitizeError(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/key=[^&\s"'`]+/gi, 'key=[REDACTED]')
    .replace(/(?:api[_-]?key|token)["':\s]+["']?([a-zA-Z0-9_\-\.]{8,})["']?/gi, 'apiKey: "[REDACTED]"')
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
    .trim();
}

// ─── 1. OpenAI-Compatible Provider ──────────────────────────────────────────

export class OpenAIProvider implements ILLMProvider {
  public readonly providerName = 'openai';
  public readonly modelName: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, model?: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.modelName = model || process.env['OPENAI_MODEL'] || process.env['LLM_MODEL'] || 'gpt-4o-mini';
    this.baseUrl = (baseUrl || process.env['OPENAI_BASE_URL'] || process.env['LLM_BASE_URL'] || 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  public async generateCompletion(
    messages: LLMMessage[],
    options?: { timeoutMs?: number; maxTokens?: number }
  ): Promise<string> {
    if (!this.isConfigured()) {
      throw new CopilotConfigError('OpenAI API key is missing. Set OPENAI_API_KEY in environment.');
    }

    const timeoutMs = options?.timeoutMs || parseInt(process.env['LLM_TIMEOUT_MS'] || '0', 10) || DEFAULT_TIMEOUT_MS;
    const maxTokens = options?.maxTokens || parseInt(process.env['LLM_MAX_TOKENS'] || '0', 10) || DEFAULT_MAX_TOKENS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelName,
          messages,
          temperature: 0.1,
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new CopilotProviderAuthError('OpenAI authentication failed: invalid API key.');
        }
        if (response.status === 429) {
          const retryHeader = response.headers.get('retry-after');
          const retrySeconds = retryHeader ? parseInt(retryHeader, 10) || 60 : 60;
          throw new CopilotRateLimitError('OpenAI rate limit exceeded. Please retry later.', retrySeconds);
        }
        const errText = await response.text().catch(() => '');
        throw new CopilotProviderError(
          `OpenAI provider returned error (${response.status}): ${errText.slice(0, 200)}`,
          response.status >= 500 ? 503 : 502
        );
      }

      const data: any = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content || typeof content !== 'string') {
        throw new CopilotProviderError('OpenAI returned empty or unexpected response format.', 502);
      }

      return content.trim();
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new CopilotTimeoutError(`OpenAI request timed out after ${timeoutMs}ms.`);
      }
      if (
        err instanceof CopilotConfigError ||
        err instanceof CopilotProviderAuthError ||
        err instanceof CopilotRateLimitError ||
        err instanceof CopilotProviderError ||
        err instanceof CopilotTimeoutError
      ) {
        throw err;
      }
      throw new CopilotProviderError(`OpenAI connection error: ${err.message || 'Network failure'}`, 503);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── 2. Anthropic Messages Provider ─────────────────────────────────────────

export class AnthropicProvider implements ILLMProvider {
  public readonly providerName = 'anthropic';
  public readonly modelName: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, model?: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.modelName = model || process.env['ANTHROPIC_MODEL'] || process.env['LLM_MODEL'] || 'claude-3-5-sonnet-20241022';
    this.baseUrl = (baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  public async generateCompletion(
    messages: LLMMessage[],
    options?: { timeoutMs?: number; maxTokens?: number }
  ): Promise<string> {
    if (!this.isConfigured()) {
      throw new CopilotConfigError('Anthropic API key is missing. Set ANTHROPIC_API_KEY in environment.');
    }

    const timeoutMs = options?.timeoutMs || parseInt(process.env['LLM_TIMEOUT_MS'] || '0', 10) || DEFAULT_TIMEOUT_MS;
    const maxTokens = options?.maxTokens || parseInt(process.env['LLM_MAX_TOKENS'] || '0', 10) || DEFAULT_MAX_TOKENS;

    const systemMsg = messages.find((m) => m.role === 'system')?.content || '';
    const nonSystemMsgs = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.modelName,
          system: systemMsg,
          messages: nonSystemMsgs,
          max_tokens: maxTokens,
          temperature: 0.1,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new CopilotProviderAuthError('Anthropic authentication failed: invalid API key.');
        }
        if (response.status === 429) {
          throw new CopilotRateLimitError('Anthropic rate limit exceeded. Please retry later.', 60);
        }
        const errText = await response.text().catch(() => '');
        throw new CopilotProviderError(
          `Anthropic provider error (${response.status}): ${errText.slice(0, 200)}`,
          response.status >= 500 ? 503 : 502
        );
      }

      const data: any = await response.json();
      const contentBlock = data?.content?.[0];
      const content = contentBlock?.text;
      if (!content || typeof content !== 'string') {
        throw new CopilotProviderError('Anthropic returned empty or unexpected response format.', 502);
      }

      return content.trim();
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new CopilotTimeoutError(`Anthropic request timed out after ${timeoutMs}ms.`);
      }
      if (
        err instanceof CopilotConfigError ||
        err instanceof CopilotProviderAuthError ||
        err instanceof CopilotRateLimitError ||
        err instanceof CopilotProviderError ||
        err instanceof CopilotTimeoutError
      ) {
        throw err;
      }
      throw new CopilotProviderError(`Anthropic connection error: ${err.message || 'Network failure'}`, 503);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── 3. Google Gemini Provider ──────────────────────────────────────────────

export class GeminiProvider implements ILLMProvider {
  public readonly providerName = 'gemini';
  public readonly modelName: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    const rawModel = model || process.env['GEMINI_MODEL'] || process.env['LLM_MODEL'] || 'gemini-3.1-flash-lite';
    // Normalize model name: remove any leading "models/" prefix and extraneous whitespace
    this.modelName = rawModel.trim().replace(/^models\//i, '');
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  public async generateCompletion(
    messages: LLMMessage[],
    options?: { timeoutMs?: number; maxTokens?: number }
  ): Promise<string> {
    if (!this.isConfigured()) {
      throw new CopilotConfigError('Gemini API key is missing. Set GEMINI_API_KEY in environment.');
    }

    const timeoutMs = options?.timeoutMs || parseInt(process.env['LLM_TIMEOUT_MS'] || '0', 10) || DEFAULT_TIMEOUT_MS;
    const maxTokens = options?.maxTokens || parseInt(process.env['LLM_MAX_TOKENS'] || '0', 10) || DEFAULT_MAX_TOKENS;

    const systemMsg = messages.find((m) => m.role === 'system')?.content || '';
    const userMsg = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const cleanModel = encodeURIComponent(this.modelName);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${encodeURIComponent(
        this.apiKey
      )}`;

      const requestBody: any = {
        contents: [{ role: 'user', parts: [{ text: userMsg }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: maxTokens,
        },
      };

      if (systemMsg) {
        requestBody.systemInstruction = {
          parts: [{ text: systemMsg }],
        };
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorDetails = '';
        try {
          const errData: any = await response.json();
          if (errData?.error?.message) {
            errorDetails = sanitizeError(errData.error.message);
          }
        } catch {
          const errText = await response.text().catch(() => '');
          errorDetails = sanitizeError(errText.slice(0, 300));
        }

        // Explicit error classification for 400, 401, 403, 404, 429, 503
        if (response.status === 400) {
          const lower = errorDetails.toLowerCase();
          if (lower.includes('api key not valid') || lower.includes('invalid api key')) {
            throw new CopilotProviderAuthError('Gemini API key is invalid or unrecognized.');
          }
          throw new CopilotProviderError(
            `Gemini invalid request parameters (400): ${errorDetails || 'Bad Request'}`,
            400
          );
        }

        if (response.status === 401) {
          throw new CopilotProviderAuthError(
            `Gemini authentication failed (401): ${errorDetails || 'Invalid API credentials.'}`
          );
        }

        if (response.status === 403) {
          throw new CopilotProviderAuthError(
            `Gemini authorization failed (403): ${errorDetails || 'API key lacks required permissions or has project restrictions.'}`
          );
        }

        if (response.status === 404) {
          throw new CopilotProviderError(
            `Gemini model "${this.modelName}" was not found for API version v1beta, or is not supported for generateContent (404). Configure GEMINI_MODEL with an available model (e.g. gemini-3.6-flash). Details: ${errorDetails || '404 Not Found'}`,
            404
          );
        }

        if (response.status === 429) {
          throw new CopilotRateLimitError(
            `Gemini rate limit or quota exceeded (429): ${errorDetails || 'Please retry later.'}`,
            60
          );
        }

        if (response.status === 503) {
          throw new CopilotProviderError(
            `Gemini service is temporarily unavailable or overloaded (503): ${errorDetails || 'Service Unavailable'}`,
            503
          );
        }

        throw new CopilotProviderError(
          `Gemini provider returned error (${response.status}): ${errorDetails || 'Unknown error'}`,
          response.status >= 500 ? 503 : 502
        );
      }

      const data: any = await response.json();
      const rawParts = data?.candidates?.[0]?.content?.parts;
      let content = '';
      if (Array.isArray(rawParts)) {
        content = rawParts
          .map((p: any) => (typeof p.text === 'string' ? p.text : ''))
          .filter(Boolean)
          .join('\n')
          .trim();
      }
      if (!content && typeof data?.candidates?.[0]?.text === 'string') {
        content = data.candidates[0].text.trim();
      }
      if (!content) {
        throw new CopilotProviderError('Gemini returned empty or unexpected response format.', 502);
      }

      return content;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new CopilotTimeoutError(`Gemini request timed out after ${timeoutMs}ms.`);
      }
      if (
        err instanceof CopilotConfigError ||
        err instanceof CopilotProviderAuthError ||
        err instanceof CopilotRateLimitError ||
        err instanceof CopilotProviderError ||
        err instanceof CopilotTimeoutError
      ) {
        throw err;
      }
      const sanitized = sanitizeError(err.message || 'Network failure');
      throw new CopilotProviderError(`Gemini connection error: ${sanitized}`, 503);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── 4. Unconfigured / Null Provider ────────────────────────────────────────

export class UnconfiguredProvider implements ILLMProvider {
  public readonly providerName = 'unconfigured';
  public readonly modelName = 'none';

  public isConfigured(): boolean {
    return false;
  }

  public async generateCompletion(): Promise<string> {
    throw new CopilotConfigError(
      'AI Copilot provider is not configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY on the backend.'
    );
  }
}

// ─── 5. Deterministic Mock LLM Provider for Testing ─────────────────────────

export interface MockLLMBehavior {
  simulateTimeout?: boolean;
  simulateRateLimit?: boolean;
  simulateAuthError?: boolean;
  simulateServerError?: boolean;
  simulateInvalidJson?: boolean;
  customResponse?: string;
  responseHook?: (messages: LLMMessage[]) => string;
}

export class MockLLMProvider implements ILLMProvider {
  public readonly providerName = 'mock';
  public readonly modelName: string;
  private behavior: MockLLMBehavior;

  constructor(model = 'mock-ops-copilot', behavior: MockLLMBehavior = {}) {
    this.modelName = model;
    this.behavior = behavior;
  }

  public setBehavior(behavior: MockLLMBehavior): void {
    this.behavior = behavior;
  }

  public isConfigured(): boolean {
    return true;
  }

  public async generateCompletion(
    messages: LLMMessage[],
    options?: { timeoutMs?: number }
  ): Promise<string> {
    if (this.behavior.simulateTimeout) {
      const wait = (options?.timeoutMs || 100) + 50;
      await new Promise((r) => setTimeout(r, wait));
      throw new CopilotTimeoutError('Mock provider simulated timeout.');
    }

    if (this.behavior.simulateRateLimit) {
      throw new CopilotRateLimitError('Mock provider simulated rate limit.', 30);
    }

    if (this.behavior.simulateAuthError) {
      throw new CopilotProviderAuthError('Mock provider simulated authentication failure.');
    }

    if (this.behavior.simulateServerError) {
      throw new CopilotProviderError('Mock provider simulated internal server error.', 503);
    }

    if (this.behavior.simulateInvalidJson) {
      return 'This is not valid JSON output from the model.';
    }

    if (this.behavior.customResponse) {
      return this.behavior.customResponse;
    }

    if (this.behavior.responseHook) {
      return this.behavior.responseHook(messages);
    }

    // Default grounded synthesizer from operational context in message
    return this.synthesizeGroundedResponse(messages);
  }

  private synthesizeGroundedResponse(messages: LLMMessage[]): string {
    const userMsg = messages.find((m) => m.role === 'user')?.content || '';
    const qMatch = userMsg.match(/<user_question>([\s\S]*?)<\/user_question>/);
    const questionText = (qMatch && qMatch[1] ? qMatch[1] : userMsg).trim();
    const qLower = questionText.toLowerCase();

    // Check for operational context block
    let contextData: any = null;
    const ctxMatch = userMsg.match(/<retrieved_operational_context>([\s\S]*?)<\/retrieved_operational_context>/);
    if (ctxMatch && ctxMatch[1]) {
      try {
        contextData = JSON.parse(ctxMatch[1].trim());
      } catch (_) {}
    }

    // Grounded synthesis based on contextData
    if (qLower.includes('how many campaigns') || qLower.includes('active campaigns') || qLower.includes('campaigns are currently active')) {
      const total = contextData?.campaign_summary?.total_campaigns ?? 0;
      const sending = contextData?.campaign_summary?.by_status?.sending ?? 0;
      return JSON.stringify({
        answer: `There are currently ${sending} active campaign(s) in sending status out of ${total} total campaign(s).`,
        insights: [`${sending} campaign(s) actively dispatching`, `${total} total campaign(s) configured`],
        recommendations: ['Monitor active campaigns for hourly throughput limits.'],
        sources: [{ type: 'campaign', label: 'campaign_summary' }],
      });
    }

    if (qLower.includes('highest failure rate') || qLower.includes('which campaign has')) {
      const highCamps = contextData?.campaign_summary?.high_failure_campaigns || [];
      if (highCamps.length > 0) {
        const top = highCamps[0];
        const pct = (top.failure_rate * 100).toFixed(1);
        return JSON.stringify({
          answer: `Campaign "${top.subject}" has the highest failure rate at ${pct}% (${top.failed_count} failed out of ${top.sent_count + top.failed_count} completed deliveries).`,
          insights: [`Campaign ID ${top.campaign_id} has ${top.failed_count} failures`, `Failure rate is ${pct}%`],
          recommendations: ['Investigate recipient syntax and SMTP response classifications in Recovery Center.'],
          sources: [{ type: 'campaign', id: top.campaign_id, label: top.subject }],
        });
      }
      return JSON.stringify({
        answer: 'No campaigns currently exhibit elevated failure rates.',
        insights: ['All campaigns operating with normal delivery rates'],
        recommendations: ['Continue routine operations monitoring.'],
        sources: [{ type: 'campaign', label: 'campaign_summary' }],
      });
    }

    if (qLower.includes('why are email deliveries failing') || qLower.includes('failure analysis') || qLower.includes('why are emails failing')) {
      const totalFailed = contextData?.failure_summary?.total_failed ?? 0;
      const topReasons = contextData?.failure_summary?.top_failure_reasons || [];
      const reasonText = topReasons.map((r: any) => `${r.reason} (${r.count})`).join(', ');
      return JSON.stringify({
        answer: `Observed ${totalFailed} total delivery failure(s). Primary failure reasons: ${reasonText || 'No failures recorded'}.`,
        insights: [
          `Transient rejections: ${contextData?.failure_summary?.transient_count ?? 0}`,
          `Permanent rejections: ${contextData?.failure_summary?.permanent_count ?? 0}`,
        ],
        recommendations: [
          'Review permanent rejections to suppress invalid recipient addresses.',
          'Transient failures will be automatically retried with exponential backoff.',
        ],
        sources: [{ type: 'delivery', label: 'failure_summary' }],
      });
    }

    if (qLower.includes('which sender') || qLower.includes('confirmed smtp acceptances') || qLower.includes('sender has the most')) {
      const senders = contextData?.sender_summary || [];
      if (senders.length > 0) {
        const sorted = [...senders].sort((a: any, b: any) => (b.confirmed_smtp_acceptances || 0) - (a.confirmed_smtp_acceptances || 0));
        const top = sorted[0];
        return JSON.stringify({
          answer: `Sender "${top.name} (${top.email})" has the most confirmed SMTP acceptances with ${top.confirmed_smtp_acceptances} verified 250 OK MTA acceptances.`,
          insights: [
            `Total attempts: ${top.total_attempts}`,
            `Unique deliveries: ${top.unique_deliveries}`,
            `Health status: ${top.health_status}`,
          ],
          recommendations: ['Maintain current sender reputation by staying within hourly dispatch caps.'],
          sources: [{ type: 'sender', id: top.sender_id, label: top.email }],
        });
      }
      return JSON.stringify({
        answer: 'No sender performance records found for authenticated user.',
        insights: ['Zero configured senders found'],
        recommendations: ['Configure verified SMTP senders in settings.'],
        sources: [{ type: 'sender', label: 'sender_summary' }],
      });
    }

    if (qLower.includes('how many emails are waiting in the queue') || qLower.includes('waiting in the queue') || qLower.includes('queue')) {
      const q = contextData?.queue_summary;
      const waiting = q?.counts?.waiting ?? 0;
      const backlog = q?.backlog ?? 0;
      return JSON.stringify({
        answer: `There are currently ${waiting} emails waiting in your tenant queue (total tenant backlog: ${backlog} jobs across waiting, active, and delayed).`,
        insights: [
          `Queue scope: ${q?.count_scope || 'tenant_scoped'}`,
          `Queue available: ${q?.available ?? true}`,
          `Delayed jobs: ${q?.counts?.delayed ?? 0}`,
        ],
        recommendations: ['Queue will drain in accordance with configured hourly limits and minimum send spacing.'],
        sources: [{ type: 'queue', label: 'email-queue' }],
      });
    }

    if (qLower.includes('uncertain smtp outcomes') || qLower.includes('unknown') || qLower.includes('uncertain outcomes')) {
      const unknowns = contextData?.failure_summary?.total_unknown ?? 0;
      return JSON.stringify({
        answer: `There are ${unknowns} delivery(ies) with uncertain SMTP outcomes pending review.`,
        insights: [
          'Uncertain outcomes occur when connections drop after DATA transfer without a conclusive 250 OK.',
          'Automated retries are suppressed to prevent duplicate recipient dispatches.',
        ],
        recommendations: [
          'Navigate to Recovery Center to inspect forensic attempt history and submit manual resolution.',
        ],
        sources: [{ type: 'delivery', label: 'unknown_deliveries' }],
      });
    }

    if (qLower.includes('bottleneck') || qLower.includes('bottlenecks') || qLower.includes('needs attention')) {
      const bList = contextData?.bottlenecks || [];
      if (bList.length > 0) {
        const topB = bList[0];
        return JSON.stringify({
          answer: `Primary operational bottleneck: ${topB.fact}`,
          insights: [topB.indicator],
          recommendations: [topB.recommendation],
          sources: (topB.source_ids || []).map((id: string) => ({ type: 'bottleneck', id })),
        });
      }
      return JSON.stringify({
        answer: 'No operational bottlenecks are currently throttling delivery throughput.',
        insights: ['System operating within configured hourly quotas and worker limits'],
        recommendations: ['No operational adjustments needed.'],
        sources: [],
      });
    }

    if (qLower.includes('what should i investigate first') || qLower.includes('investigate first') || qLower.includes('recommendation')) {
      const recs = contextData?.recommended_investigations || [];
      return JSON.stringify({
        answer: recs.length > 0 ? `Recommended priority investigation: ${recs[0]}` : 'All operations operating normally.',
        insights: ['Generated from deterministic operational telemetry and active bottlenecks'],
        recommendations: recs.slice(0, 3),
        sources: [],
      });
    }

    // Generic grounded fallback
    return JSON.stringify({
      answer: 'Telemetry retrieved successfully for authenticated tenant operations.',
      insights: [
        `Total campaigns: ${contextData?.campaign_summary?.total_campaigns ?? 0}`,
        `Total dispatches: ${contextData?.campaign_summary?.total_deliveries ?? 0}`,
      ],
      recommendations: contextData?.recommended_investigations?.slice(0, 2) || ['Review operations dashboard.'],
      sources: [],
    });
  }
}

// ─── 6. Provider Factory ────────────────────────────────────────────────────

export function getLLMProvider(options?: LLMProviderOptions): ILLMProvider {
  // If explicitly requested mock/test provider
  const providerType: LLMProviderType | string = (
    options?.provider ||
    process.env['LLM_PROVIDER'] ||
    ''
  ).toLowerCase();

  if (providerType === 'mock' || providerType === 'test') {
    return new MockLLMProvider(options?.model);
  }

  // Detect explicit or auto-detected OpenAI
  const openaiKey = options?.apiKey || process.env['OPENAI_API_KEY'] || process.env['LLM_API_KEY'];
  if (providerType === 'openai' || (!providerType && openaiKey)) {
    if (openaiKey) {
      return new OpenAIProvider(openaiKey, options?.model, options?.baseUrl);
    }
  }

  // Detect explicit or auto-detected Anthropic
  const anthropicKey = options?.apiKey || process.env['ANTHROPIC_API_KEY'];
  if (providerType === 'anthropic' || (!providerType && anthropicKey)) {
    if (anthropicKey) {
      return new AnthropicProvider(anthropicKey, options?.model, options?.baseUrl);
    }
  }

  // Detect explicit or auto-detected Gemini
  const geminiKey = options?.apiKey || process.env['GEMINI_API_KEY'];
  if (providerType === 'gemini' || (!providerType && geminiKey)) {
    if (geminiKey) {
      return new GeminiProvider(geminiKey, options?.model);
    }
  }

  // If specific provider was requested but key is missing, return unconfigured
  return new UnconfiguredProvider();
}
