/**
 * src/routes/preflight.ts
 *
 * Direct router for smart campaign preflight and delivery forecast.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { preflightCampaignHandler } from '../controllers/preflightController';

const router = Router();

router.use(requireAuth);
router.post('/', preflightCampaignHandler);

export default router;
