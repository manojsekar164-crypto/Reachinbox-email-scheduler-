import { Request, Response, NextFunction } from 'express';
import { UserRow } from '../types/db.types';

/**
 * src/middleware/requireAdmin.ts
 *
 * Enforces admin-only authorization for protected management endpoints
 * such as the Bull Board dashboard at /admin/queues.
 *
 * AUTHORIZATION DESIGN:
 *   1. Requires an authenticated user (req.user must be present and have an id).
 *   2. Identity is derived strictly from the authenticated session (Passport / requireAuth).
 *   3. Client-supplied role headers or request-body roles are strictly ignored.
 *   4. Authorized administrators are resolved from environment allowlists:
 *      - ADMIN_USER_IDS: Comma-separated list of authenticated user UUIDs.
 *      - ADMIN_EMAILS: Comma-separated list of authenticated user emails (case-insensitive).
 *   5. FAIL CLOSED: If neither ADMIN_USER_IDS nor ADMIN_EMAILS is configured,
 *      access is unconditionally denied (HTTP 403) to all users.
 *   6. Disabling: If BULL_BOARD_ENABLED is set to 'false', access is denied (HTTP 403).
 *   7. Safe Logging: Denials are logged with sanitized user identifiers and URLs.
 *      Zero session tokens, passwords, or queue payloads are logged.
 */

export interface AdminConfig {
  isConfigured: boolean;
  adminUserIds: Set<string>;
  adminEmails: Set<string>;
  boardEnabled: boolean;
}

/**
 * Reads and parses admin configuration dynamically from environment variables.
 * Dynamic resolution ensures environment changes in runtime or test suites
 * take effect immediately without requiring process restarts.
 */
export function getAdminConfig(): AdminConfig {
  const rawUserIds = process.env.ADMIN_USER_IDS ?? '';
  const rawEmails = process.env.ADMIN_EMAILS ?? '';
  const boardEnabled = process.env.BULL_BOARD_ENABLED !== 'false';

  const adminUserIds = new Set(
    rawUserIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );

  const adminEmails = new Set(
    rawEmails
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );

  const isConfigured = adminUserIds.size > 0 || adminEmails.size > 0;

  return {
    isConfigured,
    adminUserIds,
    adminEmails,
    boardEnabled,
  };
}

/**
 * Validates whether the given authenticated user matches the admin allowlist.
 * Fails closed if admin configuration is missing.
 */
export function isAdminUser(user?: { id?: string; email?: string } | null): boolean {
  if (!user || !user.id) {
    return false;
  }

  const { isConfigured, adminUserIds, adminEmails } = getAdminConfig();
  if (!isConfigured) {
    return false;
  }

  // Primary check: match by authenticated user UUID
  if (adminUserIds.has(user.id)) {
    return true;
  }

  // Secondary check: match by authenticated user email (case-insensitive)
  if (user.email && adminEmails.has(user.email.toLowerCase())) {
    return true;
  }

  return false;
}

/**
 * Express middleware that restricts access to authorized administrators.
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // 1. Verify user authentication exists
  if (!req.user || !(req.user as any).id) {
    res.status(401).json({
      error: 'Authentication required',
      message: 'You must be authenticated to access administrative resources.',
    });
    return;
  }

  const user = req.user as UserRow;

  // 2. Check if Bull Board is explicitly disabled
  const { boardEnabled, isConfigured } = getAdminConfig();
  if (!boardEnabled) {
    console.warn(
      `[Security] Bull Board access rejected: dashboard is disabled (user=${user.id}, path=${req.originalUrl})`,
    );
    res.status(403).json({
      error: 'Forbidden',
      message: 'Bull Board dashboard is disabled.',
    });
    return;
  }

  // 3. Fail closed if admin authorization is not configured
  if (!isConfigured) {
    console.warn(
      `[Security] Admin access rejected: admin allowlist is not configured (fail closed) (user=${user.id}, path=${req.originalUrl})`,
    );
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin authorization is not configured. Access denied.',
    });
    return;
  }

  // 4. Verify user against admin allowlist
  if (!isAdminUser(user)) {
    console.warn(
      `[Security] Admin access denied: user ${user.id} is not in admin allowlist (path=${req.originalUrl})`,
    );
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin privileges required. Access denied.',
    });
    return;
  }

  // Authorized admin
  next();
}
