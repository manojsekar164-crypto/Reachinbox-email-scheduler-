/**
 * src/controllers/copilotController.ts
 *
 * Controller for the AI Delivery Operations Copilot.
 * Handles POST /copilot/chat with strict authentication, input validation,
 * request-size enforcement, and structured error responses.
 */

import { Request, Response, NextFunction } from 'express';
import { UserRow } from '../types/db.types';
import { handleCopilotChat } from '../services/copilotService';
import {
  CopilotValidationError,
  CopilotRateLimitError,
  CopilotConfigError,
  CopilotProviderAuthError,
  CopilotTimeoutError,
  CopilotProviderError,
} from '../types/copilot.types';

const MAX_PAYLOAD_BYTES = 32 * 1024; // 32 KB limit

function getAuthenticatedUserId(req: Request): string {
  const user = req.user as UserRow | undefined;
  if (!user || !user.id) {
    const error: any = new Error('Authentication required');
    error.statusCode = 401;
    throw error;
  }
  return user.id;
}

/**
 * POST /copilot/chat
 * Answers operational questions using grounded telemetry and real AI provider.
 */
export async function copilotChatHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // 1. Strictly derive identity from authenticated session (never accept request-supplied user_id)
    const userId = getAuthenticatedUserId(req);

    // 2. Reject attempts to supply external user_id in payload
    if (req.body && (req.body.user_id !== undefined || req.body.userId !== undefined)) {
      res.status(400).json({
        error: 'Explicit user_id in request body is forbidden. Authorization context is strictly derived from authenticated session.',
      });
      return;
    }

    // 3. Enforce request size boundary
    const payloadLength = Buffer.byteLength(JSON.stringify(req.body || {}));
    if (payloadLength > MAX_PAYLOAD_BYTES) {
      res.status(413).json({
        error: `Payload size exceeds limit of ${MAX_PAYLOAD_BYTES} bytes.`,
      });
      return;
    }

    const { question, context } = req.body || {};

    const response = await handleCopilotChat(userId, { question, context });
    res.status(200).json(response);
  } catch (err: any) {
    if (err.message === 'Authentication required' || err.statusCode === 401) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (err instanceof CopilotValidationError || err.statusCode === 400) {
      res.status(400).json({ error: err.message || 'Validation error' });
      return;
    }

    if (err instanceof CopilotRateLimitError || err.statusCode === 429) {
      if (err.retryAfterSeconds) {
        res.setHeader('Retry-After', err.retryAfterSeconds.toString());
      }
      res.status(429).json({ error: err.message });
      return;
    }

    if (
      err instanceof CopilotConfigError ||
      err instanceof CopilotProviderAuthError ||
      err.statusCode === 503
    ) {
      res.status(503).json({ error: err.message });
      return;
    }

    if (err instanceof CopilotTimeoutError || err.statusCode === 504) {
      res.status(504).json({ error: err.message });
      return;
    }

    if (err instanceof CopilotProviderError || err.statusCode === 502) {
      res.status(err.statusCode || 502).json({ error: err.message });
      return;
    }

    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      error: err.message || 'Internal server error while processing copilot request',
    });
  }
}
