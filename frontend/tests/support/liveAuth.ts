/**
 * Auth module replacements for the LIVE suites (`tests/services/*.live.test.ts`
 * and `tests/hooks/hooks.live.test.ts`), which call a running backend with a
 * real Firebase ID token.
 *
 * The token comes from `__TEST_TOKEN__` (or `TEST_TOKEN`); see
 * `tests/services/README.md` for how to mint one. `jest.mock` factories may not
 * close over imports, so a live file wires these in through `requireActual`:
 *
 *   jest.mock('@/lib/utils/auth', () =>
 *     jest.requireActual('../support/liveAuth').liveAuthUtilsModule());
 */

export function liveTestToken(): string | null {
  return process.env.__TEST_TOKEN__ || process.env.TEST_TOKEN || null;
}

/** Stands in for `@/lib/utils/auth`, so every service sends the live token. */
export function liveAuthUtilsModule() {
  return {
    getFirebaseToken: jest.fn(async () => liveTestToken()),
    clearTokenCache: jest.fn(),
  };
}

/**
 * Stands in for `@/lib/firebase/config`, for `auth.service`, which reads the
 * token off `auth.currentUser` rather than through `@/lib/utils/auth`.
 */
export function liveFirebaseConfigModule() {
  return {
    auth: {
      currentUser: {
        getIdToken: jest.fn(async () => liveTestToken() ?? ''),
      },
    },
  };
}
