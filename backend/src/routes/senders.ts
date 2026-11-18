/**
 * src/routes/senders.ts
 *
 * All sender routes are protected by requireAuth.
 * User identity is enforced via req.user inside handlers.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import {
  createSenderHandler,
  listSendersHandler,
  getSenderHandler,
  patchSenderHandler,
  removeSenderHandler,
} from '../controllers/senderController';
import {
  listSendersHealthHandler,
  getSenderHealthHandler,
  probeSenderHandler,
} from '../controllers/senderHealthController';

const router = Router();

// Enforce authentication on all sender endpoints
router.use(requireAuth);

// ─── Sender Health Monitoring (Batch 10 / Stage 8) ───────────────────────────
router.get('/health', listSendersHealthHandler);
router.get('/:id/health', getSenderHealthHandler);
router.post('/:id/probe', probeSenderHandler);

// ─── Sender CRUD Endpoints ───────────────────────────────────────────────────
router.post('/', createSenderHandler);
router.get('/', listSendersHandler);
router.get('/:id', getSenderHandler);
router.patch('/:id', patchSenderHandler);
router.put('/:id', patchSenderHandler);
router.delete('/:id', removeSenderHandler);

export default router;
