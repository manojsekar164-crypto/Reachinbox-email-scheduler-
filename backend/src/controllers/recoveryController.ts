/**
 * src/controllers/recoveryController.ts
 *
 * HTTP handlers for the Email Failure & Recovery Center:
 *  - Failure & Unknown Delivery Listing
 *  - Delivery Details & Attempt History
 *  - Safe Manual Retry
 *  - Operator Resolution of Unknown Deliveries
 *  - Campaign Lifecycle Controls (Pause, Resume, Cancel)
 */

import { Request, Response, NextFunction } from 'express';
import { UserRow } from '../types/db.types';
import {
  listDeliveries,
  getDeliveryDetail,
  getDeliveryAttemptHistory,
  manualRetryDelivery,
  resolveUnknownDelivery,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
} from '../services/recoveryService';
import { DeliveryStatus } from '../types/db.types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

function getUserId(req: Request): string {
  const user = req.user as UserRow | undefined;
  if (!user || !user.id) {
    throw new Error('Authentication required');
  }
  return user.id;
}

/**
 * GET /deliveries
 * List deliveries with multi-criteria filtering, pagination, and sorting.
 */
export async function listDeliveriesHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = getUserId(req);
    const {
      status,
      campaign_id,
      sender_id,
      error_classification,
      from_date,
      to_date,
      limit,
      offset,
      page,
      sort_by,
      sort_order,
    } = req.query;

    let statusFilter: DeliveryStatus | DeliveryStatus[] | undefined;
    if (typeof status === 'string') {
      if (status.includes(',')) {
        statusFilter = status.split(',').map((s) => s.trim()) as DeliveryStatus[];
      } else {
        statusFilter = status as DeliveryStatus;
      }
    }

    const result = await listDeliveries({
      userId,
      status: statusFilter,
      campaignId: typeof campaign_id === 'string' ? campaign_id : undefined,
      senderId: typeof sender_id === 'string' ? sender_id : undefined,
      errorClassification: typeof error_classification === 'string' ? error_classification : undefined,
      fromDate: typeof from_date === 'string' ? from_date : undefined,
      toDate: typeof to_date === 'string' ? to_date : undefined,
      limit: limit ? parseInt(String(limit), 10) : 20,
      offset: offset ? parseInt(String(offset), 10) : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      sortBy: typeof sort_by === 'string' ? (sort_by as any) : 'created_at',
      sortOrder: typeof sort_order === 'string' && sort_order.toLowerCase() === 'asc' ? 'asc' : 'desc',
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /deliveries/failed
 * Convenience endpoint to list failed deliveries.
 */
export async function listFailedDeliveriesHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = getUserId(req);
    const {
      campaign_id,
      sender_id,
      error_classification,
      from_date,
      to_date,
      limit,
      offset,
      page,
      sort_by,
      sort_order,
    } = req.query;

    const result = await listDeliveries({
      userId,
      status: 'failed',
      campaignId: typeof campaign_id === 'string' ? campaign_id : undefined,
      senderId: typeof sender_id === 'string' ? sender_id : undefined,
      errorClassification: typeof error_classification === 'string' ? error_classification : undefined,
      fromDate: typeof from_date === 'string' ? from_date : undefined,
      toDate: typeof to_date === 'string' ? to_date : undefined,
      limit: limit ? parseInt(String(limit), 10) : 20,
      offset: offset ? parseInt(String(offset), 10) : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      sortBy: typeof sort_by === 'string' ? (sort_by as any) : 'created_at',
      sortOrder: typeof sort_order === 'string' && sort_order.toLowerCase() === 'asc' ? 'asc' : 'desc',
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /deliveries/unknown
 * Convenience endpoint to list unknown deliveries requiring operator review.
 */
export async function listUnknownDeliveriesHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = getUserId(req);
    const {
      campaign_id,
      sender_id,
      error_classification,
      from_date,
      to_date,
      limit,
      offset,
      page,
      sort_by,
      sort_order,
    } = req.query;

    const result = await listDeliveries({
      userId,
      status: 'unknown',
      campaignId: typeof campaign_id === 'string' ? campaign_id : undefined,
      senderId: typeof sender_id === 'string' ? sender_id : undefined,
      errorClassification: typeof error_classification === 'string' ? error_classification : undefined,
      fromDate: typeof from_date === 'string' ? from_date : undefined,
      toDate: typeof to_date === 'string' ? to_date : undefined,
      limit: limit ? parseInt(String(limit), 10) : 20,
      offset: offset ? parseInt(String(offset), 10) : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      sortBy: typeof sort_by === 'string' ? (sort_by as any) : 'created_at',
      sortOrder: typeof sort_order === 'string' && sort_order.toLowerCase() === 'asc' ? 'asc' : 'desc',
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /deliveries/:id
 * Retrieve details for a single delivery including latest attempt and retry eligibility.
 */
export async function getDeliveryDetailHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!isValidUuid(id)) {
      res.status(400).json({ error: 'Invalid delivery ID format (expected UUID)' });
      return;
    }

    const detail = await getDeliveryDetail(id, userId);
    res.status(200).json(detail);
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
}

/**
 * GET /deliveries/:id/attempts
 * Retrieve complete attempt history for an email delivery.
 */
export async function getDeliveryAttemptsHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!isValidUuid(id)) {
      res.status(400).json({ error: 'Invalid delivery ID format (expected UUID)' });
      return;
    }

    const attempts = await getDeliveryAttemptHistory(id, userId);
    res.status(200).json({
      delivery_id: id,
      total_attempts: attempts.length,
      attempts,
    });
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
}

/**
 * POST /deliveries/:id/retry
 * Explicitly authorized manual retry for a failed delivery.
 */
export async function manualRetryHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!isValidUuid(id)) {
      res.status(400).json({ error: 'Invalid delivery ID format (expected UUID)' });
      return;
    }

    const result = await manualRetryDelivery(id, userId);
    res.status(200).json(result);
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
}

/**
 * POST /deliveries/:id/resolve
 * Operator review and resolution of an unknown delivery.
 */
export async function resolveUnknownHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = getUserId(req);
    const { id } = req.params;
    const { decision, reason, metadata } = req.body;

    if (!isValidUuid(id)) {
      res.status(400).json({ error: 'Invalid delivery ID format (expected UUID)' });
      return;
    }

    if (!decision || (decision !== 'confirmed_accepted' && decision !== 'confirmed_not_accepted')) {
      res.status(400).json({
        error: "Invalid resolution decision: must be 'confirmed_accepted' or 'confirmed_not_accepted'",
      });
      return;
    }

    if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
      res.status(400).json({
        error: 'Mandatory resolution reason is required (minimum 3 characters)',
      });
      return;
    }

    const result = await resolveUnknownDelivery(id, userId, {
      decision,
      reason,
      metadata,
    });

    res.status(200).json(result);
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
}

/**
 * POST /campaigns/:id/pause
 * Pause campaign dispatches.
 */
export async function pauseCampaignHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!isValidUuid(id)) {
      res.status(400).json({ error: 'Invalid campaign ID format (expected UUID)' });
      return;
    }

    const result = await pauseCampaign(id, userId);
    res.status(200).json(result);
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
}

/**
 * POST /campaigns/:id/resume
 * Resume campaign dispatches.
 */
export async function resumeCampaignHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!isValidUuid(id)) {
      res.status(400).json({ error: 'Invalid campaign ID format (expected UUID)' });
      return;
    }

    const result = await resumeCampaign(id, userId);
    res.status(200).json(result);
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
}

/**
 * POST /campaigns/:id/cancel
 * Cancel remaining campaign dispatches.
 */
export async function cancelCampaignHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!isValidUuid(id)) {
      res.status(400).json({ error: 'Invalid campaign ID format (expected UUID)' });
      return;
    }

    const result = await cancelCampaign(id, userId);
    res.status(200).json(result);
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
}

/**
 * GET /campaigns/:id/deliveries
 * List deliveries for a specific campaign.
 */
export async function listCampaignDeliveriesHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = getUserId(req);
    const { id } = req.params;
    const {
      status,
      sender_id,
      error_classification,
      from_date,
      to_date,
      limit,
      offset,
      page,
      sort_by,
      sort_order,
    } = req.query;

    if (!isValidUuid(id)) {
      res.status(400).json({ error: 'Invalid campaign ID format (expected UUID)' });
      return;
    }

    let statusFilter: DeliveryStatus | DeliveryStatus[] | undefined;
    if (typeof status === 'string') {
      if (status.includes(',')) {
        statusFilter = status.split(',').map((s) => s.trim()) as DeliveryStatus[];
      } else {
        statusFilter = status as DeliveryStatus;
      }
    }

    const result = await listDeliveries({
      userId,
      campaignId: id,
      status: statusFilter,
      senderId: typeof sender_id === 'string' ? sender_id : undefined,
      errorClassification: typeof error_classification === 'string' ? error_classification : undefined,
      fromDate: typeof from_date === 'string' ? from_date : undefined,
      toDate: typeof to_date === 'string' ? to_date : undefined,
      limit: limit ? parseInt(String(limit), 10) : 20,
      offset: offset ? parseInt(String(offset), 10) : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      sortBy: typeof sort_by === 'string' ? (sort_by as any) : 'created_at',
      sortOrder: typeof sort_order === 'string' && sort_order.toLowerCase() === 'asc' ? 'asc' : 'desc',
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
