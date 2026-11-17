/**
 * src/routes/deliveries.ts
 *
 * Routes for Delivery Failure Monitoring, Attempt History,
 * Safe Manual Retry, and Operator Review Resolution.
 *
 * All routes are protected by requireAuth and scoped to the authenticated user.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import {
  listDeliveriesHandler,
  listFailedDeliveriesHandler,
  listUnknownDeliveriesHandler,
  getDeliveryDetailHandler,
  getDeliveryAttemptsHandler,
  manualRetryHandler,
  resolveUnknownHandler,
} from '../controllers/recoveryController';

const router = Router();

// Require session authentication for all delivery endpoints
router.use(requireAuth);

// ─── Listing & Monitoring ──────────────────────────────────────────────────
router.get('/failed', listFailedDeliveriesHandler);
router.get('/unknown', listUnknownDeliveriesHandler);
router.get('/', listDeliveriesHandler);

// ─── Delivery Details & Audit History ──────────────────────────────────────
router.get('/:id', getDeliveryDetailHandler);
router.get('/:id/attempts', getDeliveryAttemptsHandler);

// ─── Actions & Recovery ────────────────────────────────────────────────────
router.post('/:id/retry', manualRetryHandler);
router.post('/:id/resolve', resolveUnknownHandler);

export default router;
