/**
 * src/routes/copilot.ts
 *
 * Routes for the AI Delivery Operations Copilot.
 * All routes are protected by requireAuth and strictly tenant-scoped.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { copilotChatHandler } from '../controllers/copilotController';

const router = Router();

// Require session authentication for all Copilot endpoints
router.use(requireAuth);

router.post('/chat', copilotChatHandler);

export default router;
