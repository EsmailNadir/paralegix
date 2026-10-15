import type { User } from "firebase/auth";

/**
 * Emails that bypass the email verification requirement (test accounts that
 * can't receive verification emails).
 *
 * Source of truth: the `NEXT_PUBLIC_EMAIL_VERIFICATION_WHITELIST` env var
 * (comma-separated, lowercased), mirroring the backend's
 * `EMAIL_VERIFICATION_WHITELIST`. When that env var is set (including to ""), it
 * is the sole source of truth. When it is UNSET, we fall back to the historical
 * hardcoded dev list below ONLY in non-production builds; PRODUCTION builds
 * default to an EMPTY list so no test accounts are ever baked into the shipped
 * bundle even if the env var is forgotten.
 *
 * NOTE: this is a CLIENT-SIDE guard only. The backend env var
 * `EMAIL_VERIFICATION_WHITELIST` (backend/src/shared/middleware/auth.js) is the
 * REAL security boundary. Keep the two in sync per environment: a client-only
 * whitelist entry will still be rejected with 403 by the API unless the same
 * address is in the backend's EMAIL_VERIFICATION_WHITELIST.
 */
const DEV_VERIFICATION_WHITELIST: string[] = [
  // test law firm accounts
  "test1@gmail.com",
  "test2@gmail.com",
  "test3@gmail.com",
  "t1@gmail.com",
  "t2@gmail.com",
  "t3@gmail.com",

  // test client accounts
  "client1@gmail.com",
  "client2@gmail.com",
  "client3@gmail.com",
  "c1@gmail.com",
  "c2@gmail.com",
  "c3@gmail.com",

  // signup-flow test accounts
  "testsignup1@gmail.com",
  "testsignup2@gmail.com",
  "testsignup3@gmail.com"
];

const VERIFICATION_WHITELIST: string[] = (() => {
  const raw = process.env.NEXT_PUBLIC_EMAIL_VERIFICATION_WHITELIST;
  if (raw === undefined) {
    // Env var unset: keep the historical dev list in non-production for local
    // workflows, but NEVER bake test accounts into a production bundle.
    return process.env.NODE_ENV === 'production' ? [] : DEV_VERIFICATION_WHITELIST;
  }
  // Env var set (including "") -> it is the sole source of truth.
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
})();

const OAUTH_PROVIDER_IDS = ['google.com', 'microsoft.com'];

/**
 * Users created before this date are grandfathered in and skip email verification.
 * This is the date the email verification feature was launched.
 */
const VERIFICATION_CUTOFF_DATE = new Date('2025-02-21T00:00:00Z');

/**
 * Returns true if the user signed in via an OAuth provider (Google or Microsoft).
 * These users have their email verified by the provider.
 */
/**
 * Returns true if the given email is on the verification whitelist.
 * Useful when a full Firebase User object isn't available yet (e.g. right after registration).
 */
export function isWhitelistedEmail(email: string): boolean {
  return VERIFICATION_WHITELIST.includes(email);
}

export function isOAuthUser(user: User | null): boolean {
  if (!user) return false;
  return user.providerData.some(p => OAUTH_PROVIDER_IDS.includes(p.providerId));
}

/**
 * Single source of truth for "is the current user verified RIGHT NOW".
 *
 * Always reloads the live Firebase user first (reload() mutates auth.currentUser
 * in place), then evaluates isEmailVerified on the refreshed reference. This
 * replaces the scattered `setTimeout(..., 100)` delays that tried to wait for
 * Firebase state to settle before re-reading verification.
 *
 * Returns:
 *  - 'verified'     - user is verified (Firebase claim, OAuth, whitelist, or grandfathered)
 *  - 'not-verified' - a live user exists but is not verified
 *  - 'no-user'      - no authenticated user
 */
export async function reloadAndCheckVerified(): Promise<'verified' | 'not-verified' | 'no-user'> {
  if (typeof window === 'undefined') return 'no-user';

  const { auth: firebaseAuth } = await import('@/lib/firebase/config');
  const currentUser = firebaseAuth?.currentUser;
  if (!currentUser) return 'no-user';

  // Refresh emailVerified / provider data from Firebase servers. reload() mutates
  // the live currentUser reference in place, so re-read it afterwards.
  try { await currentUser.reload(); } catch {}

  const refreshed = firebaseAuth?.currentUser;
  if (!refreshed) return 'no-user';

  return isEmailVerified(refreshed) ? 'verified' : 'not-verified';
}

/**
 * Returns true if the user's email is considered verified,
 * either via Firebase, by being on the whitelist, by being an OAuth user,
 * or by having been created before email verification was required.
 */
export function isEmailVerified(user: User | null): boolean {
  if (!user) return false;
  if (user.emailVerified) return true;
  if (isOAuthUser(user)) return true;
  if (VERIFICATION_WHITELIST.includes(user.email ?? "")) return true;

  // Grandfather pre-existing users who registered before verification was required
  const creationTime = user.metadata?.creationTime;
  if (creationTime && new Date(creationTime) < VERIFICATION_CUTOFF_DATE) {
    return true;
  }

  return false;
}
