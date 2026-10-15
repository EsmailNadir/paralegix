/**
 * Validates required environment for real integration tests.
 * Allows pre-fetched token OR Firebase credentials for token fetch.
 */
const path = require('path');

// Nothing else in the test path loaded backend/.env, so `npm test` failed its own
// preflight from a clean shell even with the credentials sitting in that file --
// every run needed them exported by hand first. This is the earliest point both
// entry points pass through: the npm-script preflight runs this module directly,
// and Jest's globalSetup requires it before anything else. Loading here also
// reaches the workers, which inherit the parent's environment when Jest forks
// them, so TEST_API_URL set in .env is honoured too.
//
// `override: false` is dotenv's default and is the behaviour that matters: a
// variable already exported in the shell or injected by CI wins over the file.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

export function validateTestEnv() {
  const hasPrefetchedToken = Boolean(process.env.__TEST_TOKEN || process.env.__TEST_TOKEN__);
  const hasFirebaseCreds =
    Boolean(process.env.TEST_FIREBASE_API_KEY) &&
    Boolean(process.env.TEST_EMAIL) &&
    Boolean(process.env.TEST_PASSWORD);

  if (hasPrefetchedToken || hasFirebaseCreds) {
    return;
  }

  const message = [
    "Missing integration test auth environment.",
    "Provide either:",
    "  1) __TEST_TOKEN",
    "or",
    "  2) TEST_FIREBASE_API_KEY, TEST_EMAIL, and TEST_PASSWORD",
  ].join("\n");

  throw new Error(message);
}

if (require.main === module) {
  validateTestEnv();
  // Keep script output quiet when env is valid.
}
