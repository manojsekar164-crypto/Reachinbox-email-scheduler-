/**
 * src/services/authService.ts
 *
 * Database operations specific to authentication.
 * All queries use parameterised placeholders to prevent SQL injection.
 * These functions are called by the Passport strategy and auth controller.
 */

import { db } from '../db/postgres';
import { UserRow } from '../types/db.types';

/**
 * Find a user by their Google OAuth subject ID.
 * Called first on every OAuth callback (fastest path for returning users).
 */
export async function findUserByGoogleId(
  googleId: string,
): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    'SELECT * FROM users WHERE google_id = $1 LIMIT 1',
    [googleId],
  );
  return rows[0] ?? null;
}

/**
 * Find a user by email address.
 * Fallback when google_id is not found (e.g. manually-created accounts).
 */
export async function findUserByEmail(
  email: string,
): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    'SELECT * FROM users WHERE email = $1 LIMIT 1',
    [email],
  );
  return rows[0] ?? null;
}

/**
 * Find a user by their internal UUID.
 * Called by passport.deserializeUser on every authenticated request.
 */
export async function findUserById(id: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    'SELECT * FROM users WHERE id = $1 LIMIT 1',
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Insert a brand-new user that authenticated via Google for the first time.
 * All values come from the verified Google profile – never from client input.
 */
export async function createAuthUser(
  googleId: string,
  email: string,
  name: string | null,
): Promise<UserRow> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (google_id, email, name)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [googleId, email, name],
  );
  return rows[0]!;
}