/**
 * Gets a real Firebase auth token by signing in with email/password.
 * Uses Firebase Auth REST API - no SDK needed.
 *
 * The token is pre-fetched in global-setup.js and stored in process.env.
 * This avoids hitting Firebase repeatedly across many test files.
 */

const { validateTestEnv } = require('./validate-test-env');

let cachedToken: any = null;
let cachedUserId: any = null;

function extractUserIdFromJwt(token: any) {
  if (!token || typeof token !== 'string') return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return decoded.user_id || decoded.sub || null;
  } catch {
    return null;
  }
}

export async function getTestToken() {
  validateTestEnv();

  if (cachedToken) return { token: cachedToken, userId: cachedUserId };

  // Try to use the pre-fetched token from global setup
  if (process.env.__TEST_TOKEN__) {
    cachedToken = process.env.__TEST_TOKEN__;
    cachedUserId = process.env.__TEST_USER_ID__ || extractUserIdFromJwt(cachedToken);
    return { token: cachedToken, userId: cachedUserId };
  }

  // Fallback: fetch token directly (for running individual test files)
  const email = process.env.TEST_EMAIL;
  const password = process.env.TEST_PASSWORD;
  const firebaseApiKey = process.env.TEST_FIREBASE_API_KEY;

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Firebase auth failed: ${err.error?.message || 'Unknown error'}`);
  }

  const data = await res.json();
  cachedToken = data.idToken;
  cachedUserId = data.localId;

  return { token: cachedToken, userId: cachedUserId };
}

let cachedNonAdminToken: any;

/**
 * Token for an account that is NOT a platform admin, so authorization tests can
 * prove an admin-only route actually rejects a normal user. The primary test
 * account carries isAdmin = true and therefore cannot demonstrate the reject.
 *
 * Defaults to the seeded client account and can be pointed elsewhere with
 * TEST_NONADMIN_EMAIL / TEST_NONADMIN_PASSWORD. Resolves to null (rather than
 * throwing) when no such account can be signed in, letting a suite skip loudly
 * instead of failing for an environment reason.
 */
export async function getNonAdminToken() {
  if (cachedNonAdminToken !== undefined) return cachedNonAdminToken;

  const email = process.env.TEST_NONADMIN_EMAIL || 'test3client@gmail.com';
  const password = process.env.TEST_NONADMIN_PASSWORD || process.env.TEST_PASSWORD;
  const firebaseApiKey = process.env.TEST_FIREBASE_API_KEY;

  if (!email || !password || !firebaseApiKey) {
    cachedNonAdminToken = null;
    return cachedNonAdminToken;
  }

  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      }
    );
    if (!res.ok) {
      cachedNonAdminToken = null;
      return cachedNonAdminToken;
    }
    const data = await res.json();
    cachedNonAdminToken = data.idToken || null;
  } catch {
    cachedNonAdminToken = null;
  }
  return cachedNonAdminToken;
}
