import { Router } from 'express';
import healthRouter from './health.routes';
import authRouter from './auth';
import campaignRouter from './campaigns';
import emailRouter from './emails';
import senderRouter from './senders';
import preflightRouter from './preflight';
import deliveriesRouter from './deliveries';
import { queuesDashboardRouter } from './queues';

const router = Router();

// ─── Mount sub-routers ────────────────────────────────────────────────────────
router.use('/health', healthRouter);
router.use('/auth', authRouter);
router.use('/campaigns', campaignRouter);
router.use('/emails', emailRouter);
router.use('/senders', senderRouter);
router.use('/preflight', preflightRouter);
router.use('/deliveries', deliveriesRouter);

// Expose Bull Board dashboard at /admin/queues (development only)
router.use('/admin/queues', queuesDashboardRouter);

export default router;