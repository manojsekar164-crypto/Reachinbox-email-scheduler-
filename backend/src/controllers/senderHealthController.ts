/**
 * src/controllers/senderHealthController.ts
 *
 * HTTP handlers for Sender Health Monitoring and Live Diagnostic Probes (Batch 10).
 *
 * Invariants:
 *  - Enforces session authentication via `req.user.id`.
 *  - Parameter validation: UUID format validation for sender IDs.
 *  - Tenant isolation: User A cannot query or probe User B's senders.
 *  - Never exposes decrypted SMTP passwords or secrets in API responses.
 */

import { Request, Response, NextFunction } from 'express';
import {
  getSenderHealth,
  listAllSendersHealth,
  probeSenderConnectivity,
} from '../services/senderHealthService';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

function getUserId(req: Request): string {
  const user = req.user as any;
  if (!user || !user.id) {
    const error: any = new Error('Authentication required');
    error.statusCode = 401;
    throw error;
  }
  return user.id;
}

/**
 * GET /senders/health
 * Returns aggregate health metrics and status for all senders configured by the authenticated user.
 */
export async function listSendersHealthHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = getUserId(req);
    const summary = await listAllSendersHealth(userId);
    res.status(200).json(summary);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /senders/:id/health
 * Returns detailed health metrics and delivery history for a specific sender.
 */
export async function getSenderHealthHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!isValidUuid(id)) {
      res.status(400).json({ error: 'Invalid sender ID format (expected UUID)' });
      return;
    }

    const health = await getSenderHealth(id, userId);
    res.status(200).json(health);
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
}

/**
 * POST /senders/:id/probe
 * Executes a live SMTP diagnostic probe (handshake, TLS verification, and auth check).
 */
export async function probeSenderHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!isValidUuid(id)) {
      res.status(400).json({ error: 'Invalid sender ID format (expected UUID)' });
      return;
    }

    const probeResult = await probeSenderConnectivity(id, userId);
    res.status(200).json(probeResult);
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
}
