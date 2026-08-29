import { Router } from 'express';
import { healthCheck, healthCheckSearch } from '../controllers/health.controller';

const router = Router();

/**
 * GET /health
 * Liveness probe – returns service name and status.
 */
router.get('/', healthCheck);

/**
 * GET /health/search
 * Verifies Elasticsearch availability status.
 */
router.get('/search', healthCheckSearch);

export default router;
