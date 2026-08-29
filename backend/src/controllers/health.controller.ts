import { Request, Response } from 'express';
import { checkElasticsearchHealth } from '../services/searchService';

/**
 * GET /health
 * Simple liveness probe used by load balancers and Docker health checks.
 */
export function healthCheck(_req: Request, res: Response): void {
  res.status(200).json({
    status: 'ok',
    service: 'reachinbox-scheduler',
  });
}

/**
 * GET /health/search
 * Verifies Elasticsearch container cluster health and reachability.
 */
export async function healthCheckSearch(_req: Request, res: Response): Promise<void> {
  const isHealthy = await checkElasticsearchHealth();
  if (isHealthy) {
    res.status(200).json({
      status: 'ok',
      service: 'elasticsearch',
      reachable: true,
    });
  } else {
    res.status(503).json({
      status: 'error',
      service: 'elasticsearch',
      reachable: false,
    });
  }
}
