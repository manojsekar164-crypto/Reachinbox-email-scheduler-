/**
 * src/controllers/senderController.ts
 *
 * HTTP handlers for sender endpoints.
 *
 * Validation rules:
 *  - name: non-empty string
 *  - email: valid email address format
 *  - smtp_host: non-empty string
 *  - smtp_port: integer, 1-65535
 *  - smtp_secure: boolean
 *  - smtp_user: non-empty string
 *  - smtp_pass: non-empty string
 *
 * Safety:
 *  - smtp_pass is NEVER exposed in the API response or printed in logs.
 *  - Ownership is checked for all operations using req.user.
 */

import { Request, Response, NextFunction } from 'express';
import { UserRow, SenderRow } from '../types/db.types';
import {
  createSender,
  listSendersByUser,
  getSenderById,
  updateSender,
  deleteSenderForUser,
  CreateSenderInput,
  UpdateSenderInput,
} from '../services/senderService';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

function currentUser(req: Request): UserRow {
  return req.user as UserRow;
}

function sanitizeSender(sender: SenderRow) {
  const { smtp_pass, ...safeSender } = sender;
  return safeSender;
}

// ---------------------------------------------------------------------------
// POST /senders
// ---------------------------------------------------------------------------
export async function createSenderHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const errors: string[] = [];

    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    if (!name) errors.push('name is required and must be a non-empty string');

    const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
    if (!email) {
      errors.push('email is required');
    } else if (!isValidEmail(email)) {
      errors.push('email is not a valid email address');
    }

    const smtp_host = typeof body['smtp_host'] === 'string' ? body['smtp_host'].trim() : '';
    if (!smtp_host) errors.push('smtp_host is required and must be a non-empty string');

    const smtp_port = body['smtp_port'];
    if (smtp_port === undefined || smtp_port === null) {
      errors.push('smtp_port is required');
    } else {
      const parsedPort = Number(smtp_port);
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        errors.push('smtp_port must be an integer between 1 and 65535');
      }
    }

    const smtp_secure = body['smtp_secure'];
    if (smtp_secure === undefined || smtp_secure === null) {
      errors.push('smtp_secure is required');
    } else if (typeof smtp_secure !== 'boolean') {
      errors.push('smtp_secure must be a boolean');
    }

    const smtp_user = typeof body['smtp_user'] === 'string' ? body['smtp_user'].trim() : '';
    if (!smtp_user) errors.push('smtp_user is required and must be a non-empty string');

    const smtp_pass = typeof body['smtp_pass'] === 'string' ? body['smtp_pass'] : '';
    if (!smtp_pass) errors.push('smtp_pass is required and must be a non-empty string');

    if (errors.length > 0) {
      res.status(400).json({ error: 'Validation failed', details: errors });
      return;
    }

    const user = currentUser(req);

    const input: CreateSenderInput = {
      name,
      email,
      smtp_host,
      smtp_port: Number(smtp_port),
      smtp_secure: !!smtp_secure,
      smtp_user,
      smtp_pass,
    };

    const sender = await createSender(user.id, input);
    res.status(201).json(sanitizeSender(sender));
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /senders
// ---------------------------------------------------------------------------
export async function listSendersHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = currentUser(req);
    const senders = await listSendersByUser(user.id);
    res.status(200).json(senders.map(sanitizeSender));
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /senders/:id
// ---------------------------------------------------------------------------
export async function getSenderHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = currentUser(req);
    const sender = await getSenderById(req.params['id']!, user.id);
    if (!sender) {
      res.status(404).json({ error: 'Sender not found' });
      return;
    }
    res.status(200).json(sanitizeSender(sender));
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// PATCH /senders/:id
// ---------------------------------------------------------------------------
export async function patchSenderHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const errors: string[] = [];
    const updates: UpdateSenderInput = {};

    if (body['name'] !== undefined) {
      const n = typeof body['name'] === 'string' ? body['name'].trim() : '';
      if (!n) errors.push('name must be a non-empty string');
      else updates.name = n;
    }

    if (body['email'] !== undefined) {
      const e = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
      if (!e) {
        errors.push('email must be a non-empty string');
      } else if (!isValidEmail(e)) {
        errors.push('email is not a valid email address');
      } else {
        updates.email = e;
      }
    }

    if (body['smtp_host'] !== undefined) {
      const h = typeof body['smtp_host'] === 'string' ? body['smtp_host'].trim() : '';
      if (!h) errors.push('smtp_host must be a non-empty string');
      else updates.smtp_host = h;
    }

    if (body['smtp_port'] !== undefined) {
      const p = body['smtp_port'];
      if (p === null) {
        errors.push('smtp_port cannot be null');
      } else {
        const parsed = Number(p);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
          errors.push('smtp_port must be an integer between 1 and 65535');
        } else {
          updates.smtp_port = parsed;
        }
      }
    }

    if (body['smtp_secure'] !== undefined) {
      const s = body['smtp_secure'];
      if (typeof s !== 'boolean') {
        errors.push('smtp_secure must be a boolean');
      } else {
        updates.smtp_secure = s;
      }
    }

    if (body['smtp_user'] !== undefined) {
      const u = typeof body['smtp_user'] === 'string' ? body['smtp_user'].trim() : '';
      if (!u) errors.push('smtp_user must be a non-empty string');
      else updates.smtp_user = u;
    }

    if (body['smtp_pass'] !== undefined) {
      const pass = typeof body['smtp_pass'] === 'string' ? body['smtp_pass'] : '';
      if (!pass) errors.push('smtp_pass must be a non-empty string');
      else updates.smtp_pass = pass;
    }

    if (errors.length > 0) {
      res.status(400).json({ error: 'Validation failed', details: errors });
      return;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({
        error: 'No valid fields provided for update',
        allowed: ['name', 'email', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass'],
      });
      return;
    }

    const user = currentUser(req);
    const updated = await updateSender(req.params['id']!, user.id, updates);
    if (!updated) {
      res.status(404).json({ error: 'Sender not found' });
      return;
    }

    res.status(200).json(sanitizeSender(updated));
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// DELETE /senders/:id
// ---------------------------------------------------------------------------
export async function removeSenderHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = currentUser(req);
    const deleted = await deleteSenderForUser(req.params['id']!, user.id);
    if (!deleted) {
      res.status(404).json({ error: 'Sender not found' });
      return;
    }
    res.status(200).json({ message: 'Sender deleted successfully' });
  } catch (err: any) {
    // If the service threw the restriction error, return it with 400
    if (err.message.includes('actively referenced by one or more campaigns')) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
}
