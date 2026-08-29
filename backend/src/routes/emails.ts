import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { searchEmailsController } from '../controllers/emailController';

const router = Router();

// Require session authentication for all search endpoints
router.use(requireAuth);

router.get('/search', searchEmailsController);

export default router;
