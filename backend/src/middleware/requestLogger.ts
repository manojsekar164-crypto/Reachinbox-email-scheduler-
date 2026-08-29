import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

/**
 * Request logger middleware.
 * Logs method, URL, status, and response time.
 * Active in development mode only; in production use a dedicated logger (e.g. pino).
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!config.app.isDev) {
    next();
    return;
  }

  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${duration}ms)`,
    );
  });

  next();
}
