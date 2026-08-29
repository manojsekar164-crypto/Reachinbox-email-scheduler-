import { ExpressAdapter } from '@bull-board/express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { emailQueue } from '../queue/emailQueue';

/**
 * src/routes/queues.ts
 *
 * Configures the Bull Board dashboard to visualize our BullMQ queues.
 * Mounted at /admin/queues (development only).
 */

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter,
});

export const queuesDashboardRouter = serverAdapter.getRouter();
