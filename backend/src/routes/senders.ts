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

const router = Router();

// Enforce authentication on all sender endpoints
router.use(requireAuth);

router.post('/', createSenderHandler);
router.get('/', listSendersHandler);
router.get('/:id', getSenderHandler);
router.patch('/:id', patchSenderHandler);
router.delete('/:id', removeSenderHandler);

export default router;
