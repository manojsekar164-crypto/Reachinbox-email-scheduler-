
/**
 * src/auth/passport.ts
 *
 * Configures optional Google OAuth 2.0 authentication.
 * Google OAuth is enabled only when valid configuration is supplied.
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

// Check whether Google OAuth credentials are configured.
export const googleOAuthConfigured =
  Boolean(config.google.clientId.trim()) &&
  Boolean(config.google.clientSecret.trim()) &&
  Boolean(config.google.callbackUrl.trim());

// Store only the user UUID in the session.
passport.serializeUser((user: Express.User, done) => {
  done(null, (user as UserRow).id);
});

// Load the authenticated user from PostgreSQL.
passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await findUserById(id);
    done(null, user ?? false);
  } catch (err) {
    done(err, false);
  }
});

// Register Google OAuth only when credentials are configured.
if (googleOAuthConfigured) {
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

          let user = await findUserByGoogleId(googleId);

          if (!user) {
            user = await findUserByEmail(email);
          }

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
}

export default passport;
