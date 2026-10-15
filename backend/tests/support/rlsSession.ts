/**
 * Run a query as a Supabase Realtime client would: as the `authenticated` role,
 * with `request.jwt.claims` naming a Firebase uid, inside a transaction that is
 * always rolled back.
 *
 * The identity reaches the policies through `auth.jwt()`, which vanilla Postgres
 * does not have. `scripts/test-db-shim.sql` defines it to read the same GUC that
 * Supabase's own definition reads.
 */
import { PoolClient } from 'pg';
import { testPool } from './db';

/** What a single statement did when it ran under a policy. */
export interface RlsAttempt {
  /** True when the statement completed. False when the database refused it. */
  ok: boolean;
  /** The refusal message, or an empty string when the statement completed. */
  message: string;
}

export async function withRlsIdentity<T>(
  uid: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');

    // Simulate Supabase Realtime's RLS environment:
    // Set the JWT claims containing the sub (user_id) and role
    await client.query(
      `SELECT set_config('request.jwt.claims', $1::text, true)`,
      [JSON.stringify({ sub: uid, role: 'authenticated' })],
    );

    // Switch to the authenticated role
    await client.query('SET LOCAL ROLE authenticated');

    // Verify we're actually under RLS
    const { rows } = await client.query(`
      SELECT
        current_user,
        current_setting('is_superuser', true) as su
    `);

    if (rows[0].su === 'on') {
      throw new Error('RLS test running as superuser - policies will be bypassed');
    }

    if (rows[0].current_user !== 'authenticated') {
      throw new Error(`Expected role to be 'authenticated', got '${rows[0].current_user}'`);
    }

    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/**
 * Run one statement that is expected to be REFUSED, without poisoning the rest
 * of the transaction.
 *
 * Postgres aborts the whole transaction on any error, so a second refused
 * statement in the same block reports "current transaction is aborted" instead
 * of its own reason. A test asserting three separate refusals would then only
 * ever prove the first one. The savepoint isolates each attempt, so each
 * statement reports the refusal it actually earned.
 *
 * Returns the outcome rather than asserting it, so a spec can say what it
 * expected. `ok: true` means the database ALLOWED the statement, which for a
 * policy test is the failure.
 */
export async function attemptUnderRls(
  client: PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<RlsAttempt> {
  await client.query('SAVEPOINT rls_attempt');
  try {
    await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT rls_attempt');
    return { ok: true, message: '' };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT rls_attempt');
    return { ok: false, message: (error as Error).message };
  }
}
