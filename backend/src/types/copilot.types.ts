/**
 * src/types/copilot.types.ts
 *
 * Types for the ReachInbox AI Delivery Operations Copilot.
 * Defines request/response contracts, LLM provider abstractions,
 * source citations, and error classes.
 */

export interface CopilotChatContext {
  date_range?: 'last_24_hours' | 'last_7_days' | 'last_30_days' | 'all_time';
  campaign_id?: string;
  from_date?: string;
  to_date?: string;
}

export interface CopilotChatRequest {
  question: string;
  context?: CopilotChatContext;
}

export type CopilotSourceType =
  | 'campaign'
  | 'delivery'
  | 'sender'
  | 'queue'
  | 'bottleneck';

export interface CopilotSourceReference {
  type: CopilotSourceType;
  id?: string;
  label?: string;
}

export interface CopilotDataFreshness {
  retrieved_at: string;
  is_partial: boolean;
  sample_limit?: number;
}

export interface CopilotChatResponse {
  success: boolean;
  answer: string;
  insights: string[];
  recommendations: string[];
  sources: CopilotSourceReference[];
  generated_at: string;
  data_freshness: CopilotDataFreshness;
}

export type LLMProviderType = 'openai' | 'anthropic' | 'gemini' | 'mock' | 'test';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMProviderOptions {
  provider?: LLMProviderType;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

export interface ILLMProvider {
  readonly providerName: string;
  readonly modelName: string;
  isConfigured(): boolean;
  generateCompletion(
    messages: LLMMessage[],
    options?: { timeoutMs?: number; maxTokens?: number }
  ): Promise<string>;
}

// ─── Error Classes ────────────────────────────────────────────────────────────

export class CopilotValidationError extends Error {
  public readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'CopilotValidationError';
  }
}

export class CopilotAuthError extends Error {
  public readonly statusCode = 401;
  constructor(message: string = 'Authentication required') {
    super(message);
    this.name = 'CopilotAuthError';
  }
}

export class CopilotRateLimitError extends Error {
  public readonly statusCode = 429;
  public readonly retryAfterSeconds: number;
  constructor(message: string = 'Too many requests. Please slow down.', retryAfterSeconds: number = 60) {
    super(message);
    this.name = 'CopilotRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class CopilotConfigError extends Error {
  public readonly statusCode = 503;
  constructor(
    message: string = 'AI Copilot provider is not configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY on the backend.'
  ) {
    super(message);
    this.name = 'CopilotConfigError';
  }
}

export class CopilotProviderAuthError extends Error {
  public readonly statusCode = 503;
  constructor(message: string = 'LLM provider authentication failed. Check API credentials on server.') {
    super(message);
    this.name = 'CopilotProviderAuthError';
  }
}

export class CopilotTimeoutError extends Error {
  public readonly statusCode = 504;
  constructor(message: string = 'AI Copilot provider request timed out. Please try again.') {
    super(message);
    this.name = 'CopilotTimeoutError';
  }
}

export class CopilotProviderError extends Error {
  public readonly statusCode: number;
  constructor(message: string, statusCode: number = 502) {
    super(message);
    this.name = 'CopilotProviderError';
    this.statusCode = statusCode;
  }
}
