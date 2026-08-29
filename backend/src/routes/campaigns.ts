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

const router = Router();

// All campaign routes require a valid session.
router.use(requireAuth);

// ─── Campaign CRUD ────────────────────────────────────────────────────────────
router.post('/', createCampaign);
router.get('/', listCampaigns);
router.get('/:id', getCampaign);
router.patch('/:id', patchCampaign);
router.delete('/:id', removeCampaign);

// ─── Recipients ───────────────────────────────────────────────────────────────
router.get('/:id/recipients', listRecipients);

export default router;