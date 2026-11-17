import { Router } from 'express';
import { ExpressAdapter } from '@bull-board/express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { emailQueue } from '../queue/emailQueue';
import { requireAuth } from '../middleware/requireAuth';
import { requireAdmin } from '../middleware/requireAdmin';

/**
 * src/routes/queues.ts
 *
 * Configures the Bull Board dashboard to visualize our BullMQ queues.
 * Mounted at /admin/queues.
 *
 * SECURITY:
 *   Protected by requireAuth and requireAdmin middleware.
 *   Only authenticated administrators listed in ADMIN_USER_IDS (or ADMIN_EMAILS)
 *   can access the dashboard, API endpoints, or assets.
 */

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter,
});

const queuesDashboardRouter = Router();

// Apply authentication and admin authorization across all dashboard routes, APIs, and assets
queuesDashboardRouter.use(requireAuth);
queuesDashboardRouter.use(requireAdmin);
queuesDashboardRouter.use(serverAdapter.getRouter());

export { queuesDashboardRouter };
