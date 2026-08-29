/**
 * src/auth/passport.ts
 *
 * Configures the Passport Google OAuth 2.0 strategy and
 * defines serialize/deserialize so Express sessions work correctly.
 *
 * SECURITY NOTES:
 *  - Only the user UUID is stored in the session – not the full user object.
 *  - Only 'openid profile email' scopes are requested from Google.
 *  - GOOGLE_CLIENT_SECRET is never logged or exposed.
 *  - Access tokens and refresh tokens are intentionally discarded.
 */

import passport from 'passport';
import {
  Strategy as GoogleStrategy,
  Profile,
  VerifyCallback,
} from 'passport-google-oauth20';
import { config } from '../config';
import {
  findUserByGoogleId,
  findUserByEmail,
  createAuthUser,
  findUserById,
} from '../services/authService';
import { UserRow } from '../types/db.types';

// ─── Serialize ────────────────────────────────────────────────────────────────
// Store only the user UUID in the session cookie; nothing sensitive.
passport.serializeUser((user: Express.User, done) => {
  done(null, (user as UserRow).id);
});

// ─── Deserialize ──────────────────────────────────────────────────────────────
// On every authenticated request, load the user from PostgreSQL via their UUID.
passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await findUserById(id);
    done(null, user ?? false);
  } catch (err) {
    done(err, false);
  }
});

// ─── Google Strategy ─────────────────────────────────────────────────────────
passport.use(
  new GoogleStrategy(
    {
      clientID: config.google.clientId,
      clientSecret: config.google.clientSecret,
      callbackURL: config.google.callbackUrl,
      scope: ['openid', 'profile', 'email'],
    },
    async (
      _accessToken: string,
      _refreshToken: string,
      profile: Profile,
      done: VerifyCallback,
    ) => {
      // Tokens are intentionally not logged or persisted in this phase.
      try {
        const googleId = profile.id;
        const email = profile.emails?.[0]?.value ?? null;
        const name = profile.displayName ?? null;

        if (!email) {
          return done(
            new Error('Google account returned no verified email address'),
            undefined,
          );
        }

        // Step 1: find by google_id – fast path for returning users.
        let user = await findUserByGoogleId(googleId);

        // Step 2: find by email – handles accounts created before OAuth.
        if (!user) {
          user = await findUserByEmail(email);
        }

        // Step 3: first-time login – create the user record.
        if (!user) {
          user = await createAuthUser(googleId, email, name);
        }

        return done(null, user);
      } catch (err) {
        return done(err as Error, undefined);
      }
    },
  ),
);

export default passport;