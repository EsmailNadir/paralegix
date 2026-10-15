/**
 * Jest global setup - runs ONCE before all test suites.
 * Fetches a Firebase auth token and stores it in an environment variable
 * so that each worker / test file can read it without hitting Firebase again.
 */

const { validateTestEnv } = require('./validate-test-env');

export = async function globalSetup() {
  validateTestEnv();

  // If token is already provided by CI or caller, reuse it.
  if (process.env.__TEST_TOKEN__) {
    return;
  }

  const email = process.env.TEST_EMAIL;
  const password = process.env.TEST_PASSWORD;
  const firebaseApiKey = process.env.TEST_FIREBASE_API_KEY;

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Firebase auth failed in global setup: ${err.error?.message || 'Unknown error'}`);
  }

  const data = await res.json();

  // Store in env vars so each worker can pick them up
  process.env.__TEST_TOKEN__ = data.idToken;
  process.env.__TEST_USER_ID__ = data.localId;
};
