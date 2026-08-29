/**
 * Shared TypeScript interfaces and types for the application.
 * Extend this file as Phase 2+ features are added.
 */

// ─── API Response envelope ────────────────────────────────────────────────────
export interface ApiResponse<T = unknown> {
  status: 'ok' | 'error';
  data?: T;
  message?: string;
}

// ─── Express augmentation ─────────────────────────────────────────────────────
// Placeholder for future req.user or similar augmentations.
// declare global {
//   namespace Express {
//     interface Request {
//       user?: AuthenticatedUser;
//     }
//   }
// }
