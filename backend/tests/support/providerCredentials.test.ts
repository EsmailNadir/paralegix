/**
 * The suite must not carry a real provider credential.
 *
 * `tests/support/db.ts` loads `backend/.env`, because several src modules read
 * configuration at module load and `RBAC_ENFORCED` has to be right before the
 * app is required. That load brings the developer's REAL secrets with it:
 * Stripe, Google, Microsoft, Resend, the Supabase service role key, and the
 * connection strings for the staging and production databases.
 *
 * Two things follow, and both are worse than they look.
 *
 * A fetch wall does not fix it. `tests/calendar/support/googleFetch.ts` replaces
 * `globalThis.fetch`, which covers Google and Microsoft Graph inside the calendar
 * specs. stripe-node does not use `fetch`: it builds a node `https` client, so a
 * spec that reaches a Stripe code path talks to the real account with the real
 * key, and no fetch stub anywhere would stop it. Today that is prevented only in
 * the seven spec files that `jest.mock` `stripe.config`, one file at a time,
 * each with its own placeholder string.
 *
 * And a suite that behaves differently depending on whose laptop it runs on is
 * not a suite. `crosscutting/entityIdHandling.matters.test.ts` already accepts
 * either of two refusals from the same route because one appears with a Stripe
 * key present and the other without.
 *
 * So the harness pins the credentials itself. These tests fail on a machine with
 * a populated `.env` if that pinning is removed.
 */
import './setupInProcess';
import { BLOCKED_DATABASE_URL, TEST_PROVIDER_CREDENTIALS } from './db';

describe('the test process holds no real provider credential', () => {
  it.each(Object.keys(TEST_PROVIDER_CREDENTIALS))('pins %s to its test placeholder', (name) => {
    expect(process.env[name]).toBe(TEST_PROVIDER_CREDENTIALS[name]);
  });

  it('pins a Stripe key that cannot authenticate against a real account', () => {
    // Present rather than absent on purpose: `stripe.config` builds a client
    // only when the key is set, and the routes that answer 503 with no client
    // are a different code path from the ones under test. A key that is present
    // but invalid keeps the normal path and fails at Stripe's door.
    expect(process.env.STRIPE_SECRET_KEY).toMatch(/^sk_test_/);
    expect(process.env.STRIPE_SECRET_KEY).toContain('paralegix-suite');
  });

  it('blanks the PostHog token, so no product event leaves the suite', () => {
    // Blank rather than a placeholder: any non-empty token makes the analytics
    // module build a real client and post batches to PostHog's host. Blank
    // rather than deleted, for the dotenv reason in the case below.
    expect(process.env.POSTHOG_PROJECT_TOKEN).toBe('');
  });

  it('overwrites the staging and production connection strings', () => {
    // `resolveDbUrl()` reads `DATABASE_URL_${DB_TARGET}`. `db.ts` blanks
    // DB_TARGET, but leaving these in the environment means one stray helper
    // that sets it can point a truncating test suite at a real database.
    expect(process.env.DATABASE_URL_PROD).toBe(BLOCKED_DATABASE_URL);
    expect(process.env.DATABASE_URL_STAGING).toBe(BLOCKED_DATABASE_URL);
  });

  it('cannot be fixed by DELETING those variables, which is why they are overwritten', () => {
    // `src/shared/database/db.ts` calls dotenv.config() again when the app is
    // imported. dotenv leaves a variable that is already set alone, but a
    // deleted one is no longer set, so the real connection string comes back.
    // This pins the reason, so the next person does not try `delete` and watch
    // it silently fail.
    delete process.env.DATABASE_URL_PROD;
    require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
    const restored = process.env.DATABASE_URL_PROD;
    process.env.DATABASE_URL_PROD = BLOCKED_DATABASE_URL;

    // Only meaningful on a machine that HAS a .env with that key. On CI there is
    // no .env, nothing is restored, and the deletion would have held.
    if (restored !== undefined) {
      expect(restored).not.toBe(BLOCKED_DATABASE_URL);
    }
  });

  it('leaves the database url pointing at this worker only', () => {
    // The positive control. Without it, the assertions above would also pass in
    // a process that had no database configured at all.
    expect(process.env.DATABASE_URL).toMatch(/paralegix_test/);
  });
});
