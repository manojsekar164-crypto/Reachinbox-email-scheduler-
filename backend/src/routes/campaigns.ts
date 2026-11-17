/**
 * src/routes/campaigns.ts
 *
 * All campaign routes are protected by requireAuth.
 * The authenticated user's identity is read from req.user inside controllers –
 * user_id is NEVER accepted from the request body.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import {
  createCampaign,
  listCampaigns,
  getCampaign,
  patchCampaign,
  removeCampaign,
  listRecipients,
} from '../controllers/campaignController';
import { preflightCampaignHandler } from '../controllers/preflightController';
import {
  pauseCampaignHandler,
  resumeCampaignHandler,
  cancelCampaignHandler,
  listCampaignDeliveriesHandler,
} from '../controllers/recoveryController';

const router = Router();

// All campaign routes require a valid session.
router.use(requireAuth);

// ─── Smart Campaign Preflight ────────────────────────────────────────────────
router.post('/preflight', preflightCampaignHandler);
router.post('/:id/preflight', preflightCampaignHandler);

// ─── Campaign Lifecycle Controls ─────────────────────────────────────────────
router.post('/:id/pause', pauseCampaignHandler);
router.post('/:id/resume', resumeCampaignHandler);
router.post('/:id/cancel', cancelCampaignHandler);

// ─── Campaign CRUD ────────────────────────────────────────────────────────────
router.post('/', createCampaign);
router.get('/', listCampaigns);
router.get('/:id', getCampaign);
router.patch('/:id', patchCampaign);
router.delete('/:id', removeCampaign);

// ─── Recipients & Deliveries ──────────────────────────────────────────────────
router.get('/:id/recipients', listRecipients);
router.get('/:id/deliveries', listCampaignDeliveriesHandler);

export default router;