/**
 * Test-database access for the in-process suite.
 *
 * Fixtures are seeded through this pool with plain SQL, not through the app's
 * repositories. A fixture built by the code under test cannot fail when that
 * code is wrong, and that is exactly how the organization bugs in be459ec0
 * survived: every path that could have noticed went through the same broken
 * helper.
 *
 * ONE DATABASE PER JEST WORKER. Jest runs spec files in parallel, and the suite
 * empties every table between files, so a single shared database would let one worker wipe
 * another mid-test. The name carries JEST_WORKER_ID, which Jest sets to '1'
 * upward per worker and leaves unset outside one. `scripts/setup-test-db.sh`
 * builds the matching set.
 *
 * Isolation WITHIN a worker is by emptying the tables between files, not by a wrapping
 * transaction: the app checks connections out of its own pool, so a transaction
 * held open here would be invisible to it.
 *
 * This module has an import side effect, and the order matters: it points the
 * app's own connection at this worker's database. It must therefore be imported
 * before anything that reaches `src/`, which is what `setupInProcess.ts`
 * guarantees and what `app.ts` relies on by importing it.
 */
import { Pool } from 'pg';

// Load backend/.env before anything else, exactly as src/server.ts does on its
// first line. Several modules read configuration at MODULE LOAD rather than per
// request, and `RBAC_ENFORCED` is the one that bites: roles.service.ts captures
// it into a const on import, and resolves every member to the full permission
// set when it is not 'true'. Production is safe because server.ts loads dotenv
// before requiring the app. A test process that skipped this would silently run
// with permissions disabled, so every RBAC assertion would pass for the wrong
// reason, or fail for one.
require('dotenv').config({
  path: require('path').join(__dirname, '..', '..', '.env'),
  quiet: true,
});

/**
 * What every external-provider secret is pinned to while the suite runs.
 *
 * The dotenv load above is required (see the comment on it), and it brings the
 * developer's real keys with it. A fetch stub does not contain them: stripe-node
 * builds a node `https` client rather than calling `fetch`, so a spec that
 * reaches a Stripe code path would talk to the real account. Six spec files had
 * each solved this for themselves with their own placeholder string before this
 * existed.
 *
 * Values are deliberately recognisable in a stack trace or a provider's logs, so
 * a credential that somehow does leave the process is obviously the suite's.
 *
 * NOT included, on purpose:
 *   SUPABASE_JWT_SECRET  the RLS specs sign JWTs the database itself verifies,
 *                        so it has to match the database's configured secret.
 *                        It signs nothing that leaves this machine.
 *   DATABASE_URL         set below, per worker.
 */
/** Stands in for a connection string no test may reach. Not a resolvable host. */
export const BLOCKED_DATABASE_URL = 'postgres://paralegix-suite-blocked/do-not-connect';

export const TEST_PROVIDER_CREDENTIALS: Record<string, string> = {
  STRIPE_SECRET_KEY: 'sk_test_paralegix-suite-not-a-real-key',
  STRIPE_WEBHOOK_SECRET: 'whsec_paralegix-suite-not-a-real-secret',
  STRIPE_SUBSCRIPTION_WEBHOOK_SECRET: 'whsec_paralegix-suite-not-a-real-subscription-secret',
  STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_paralegix-suite-not-a-real-connect-secret',
  GOOGLE_CLIENT_SECRET: 'paralegix-suite-not-a-real-google-secret',
  MICROSOFT_CLIENT_SECRET: 'paralegix-suite-not-a-real-microsoft-secret',
  RESEND_API_KEY: 're_paralegix-suite-not-a-real-key',
  SUPABASE_SERVICE_ROLE_KEY: 'paralegix-suite-not-a-real-service-role-key',
  FIREBASE_SERVICE_ACCOUNT_KEY: 'paralegix-suite-not-a-real-service-account',
};

// Applied before ANY src/ module loads: `stripe.config` captures the key into a
// module-level const on import, so pinning it later would leave a client already
// built from the developer's real key.
for (const [name, value] of Object.entries(TEST_PROVIDER_CREDENTIALS)) {
  process.env[name] = value;
}

// The staging and production connection strings are OVERWRITTEN, not deleted.
// `resolveDbUrl()` reads `DATABASE_URL_${DB_TARGET}`, and this file blanks
// DB_TARGET below, but a helper that sets it for its own reasons would otherwise
// point a suite that truncates every table at a real database.
//
// Deleting them does not work, which is worth knowing before trying it again:
// `src/shared/database/db.ts:9` calls `require('dotenv').config()` on import.
// dotenv does not overwrite a variable that is already SET, which is why the
// placeholders above survive it, but a variable that has been DELETED is no
// longer set, so that second load puts the real connection string straight back.
process.env.DATABASE_URL_PROD = BLOCKED_DATABASE_URL;
process.env.DATABASE_URL_STAGING = BLOCKED_DATABASE_URL;

// Blank, not a placeholder: `shared/analytics/serverAnalytics.ts` builds a real
// PostHog client for ANY non-empty token and posts batches to its host, so a
// fake token would still send the suite's events over the network. Empty is the
// module's disabled state, and it survives the second dotenv load for the same
// reason the overwrites above do.
process.env.POSTHOG_PROJECT_TOKEN = '';
// The same for account erasure's PostHog person deletion: without a personal key
// it does nothing, so a developer's real key in .env never reaches PostHog.
process.env.POSTHOG_PERSONAL_API_KEY = '';

// Set before ANY src/ module loads, because several read configuration into a
// module-level const rather than per request.
process.env.NODE_ENV = 'test';
// Forced, not merely read from .env, because .env is untracked and CI has none.
// roles.service.ts captures this into a module-level const on import and, when
// it is anything but 'true', resolves EVERY firm member to the full permission
// set. A suite running that way does not fail: every "refuses a member without
// the permission" case simply gets a 200 and reports a wrong expectation, so
// the whole RBAC half of the suite passes for the wrong reason locally and
// fails only on a machine without a .env. Pinning it here makes the harness
// self-contained and identical in both places.
process.env.RBAC_ENFORCED = 'true';
// Forced off for the same reason as RBAC_ENFORCED. stripe.service.ts captures it
// into a module-level const on import, and .env on a developer machine may set it
// 'true' while CI has no .env at all, so the same refund or dispute spec would run
// the cash-recovery path (reversing transfers, charging the firm's card) locally and
// skip it in CI. Off is the production default. The one spec that exercises recovery
// sets it back on after importing this module and before the app loads.
process.env.STRIPE_AUTO_RECOVERY_ENABLED = 'false';
// Rate limiters read this per request. Live limiters would add a Postgres write
// per call, couple unrelated specs through the shared `rate_limits` table, and
// answer 429 to a suite that is behaving correctly.
process.env.RATE_LIMITS_DISABLED = 'true';
// The request logger writes a JSON line per request, and a 403 or 404 is a
// WARNING carrying a full stack trace. A suite that asserts on those on purpose
// would bury its own failures under them. Set TEST_LOG_LEVEL to see them while
// debugging one spec.
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL || 'silent';
// Cap the app's own pool. Jest runs one worker per cpu, each worker loads the
// app and opens its own pool, and the production default of 10 is sized for a
// Cloud Run instance serving real traffic, not for a dozen test processes on one
// laptop. Thirteen workers at 10 apiece, plus this file's own pool, exceeded both
// the container's max_connections of 100 and its 512MiB memory limit: Postgres
// was OOM-killed mid-run (`checkpointer process was terminated by signal 9`),
// which surfaced once as 118 unrelated failures and once as a hard crash into
// recovery mode.
//
// 5 and 1 are the SMALLEST pair the app's own guards accept: connectionBudget
// requires poolMax - RESERVE >= 1, and dashboard.service refuses to load unless
// the remainder is at least 4, the weight of its heaviest section.
//
// SMALLEST turned out not to be enough. Several services fan out with
// Promise.all -- the split-invoice path opens with a three-way one, and the
// unbilled summary underneath it opens more -- so a SINGLE request can hold
// four connections at once. With a max of 5 and one reserved, the next
// concurrent query waits on the pool, and under full-suite load it waited long
// enough that the request died and supertest reported a bare "socket hang up".
// That read as a bug in whichever test drew the short straw, and it moved
// around as the suite grew.
//
// Ten fixed it: five consecutive full-suite runs clean, against roughly one
// failure in three before. Four workers at ten connections is forty, well
// inside the container's max_connections of 100.
process.env.PG_POOL_MAX = process.env.PG_POOL_MAX || '10';
process.env.PG_POOL_RESERVE = process.env.PG_POOL_RESERVE || '1';

// TEST_DB_SLOT wins over the worker id so several INDEPENDENT jest processes can
// run at once without truncating each other. Jest overwrites JEST_WORKER_ID in
// every process it owns, `--runInBand` included, so exporting that variable does
// not work: two concurrent runs both land on paralegix_test_1 and each wipes the
// other's fixtures mid-file. Slots 1-4 belong to the suite's own workers; use 5
// and up for anything running alongside it. `scripts/setup-test-db.sh` builds the
// set.
const WORKER = process.env.TEST_DB_SLOT || process.env.JEST_WORKER_ID || '1';
const BASE = process.env.DATABASE_URL_TEST
  || 'postgresql://postgres:postgres@localhost:5433/paralegix_test';

export const TEST_DATABASE_URL = `${BASE}_${WORKER}`;

// A misconfigured DATABASE_URL_TEST is the one mistake in this file that could
// truncate a real database, so refuse anything whose name is not obviously a
// test database rather than trusting the caller.
if (!/\/paralegix_test(_\d+)?$/.test(TEST_DATABASE_URL)) {
  throw new Error(
    `Refusing to run: DATABASE_URL_TEST does not name a test database (${TEST_DATABASE_URL}). `
    + 'Expected a URL ending in /paralegix_test.',
  );
}

// Point the app at this worker's database. DATABASE_URL is set directly, and
// DB_TARGET cleared, because resolveDbUrl() prefers DATABASE_URL_<TARGET> and
// would otherwise send the app to whatever DB_TARGET names in backend/.env,
// which on a developer machine is usually staging.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.DB_TARGET = '';

// Small for the same reason as PG_POOL_MAX above: fixtures are sequential, so a
// worker never has more than one query of its own in flight.
// `lock_timeout` is what stops a blocked reset from hanging the whole run.
// `truncateAll` takes a row lock on every occupied table at once, and Postgres
// only raises 40P01 when the wait forms a genuine CYCLE. A straggler that
// merely holds a lock without wanting one this statement holds is not a
// deadlock, so the reset waits, by default forever, and Jest goes silent
// with no failing test and no output. CI showed exactly that: 46 suites
// reported, then thirteen minutes of nothing. Ten seconds is far above a
// healthy reset, which is milliseconds, so this only ever fires on a real
// stall, and it turns that stall into a named error the retry below can act on.
export const testPool = new Pool({
  connectionString: TEST_DATABASE_URL,
  max: 2,
  options: '-c lock_timeout=10s',
});

// A worker with no database of its own fails with a bare
// `database "paralegix_test_9" does not exist`, which reads as a broken test
// rather than a setup step that has not kept up with the machine. Jest scales
// its worker count to the cpu count, so this happens the first time the suite
// grows enough to use another worker.
testPool.on('error', () => undefined);
export function missingDatabaseHint(err: unknown): string | null {
  const message = (err as { message?: string })?.message ?? '';
  if (!/database .* does not exist/.test(message)) return null;
  return `${message}\n\nWorker ${WORKER} has no test database. Run: npm run test:db`;
}

let cachedTableList: string | null = null;
let cachedOccupancyQuery: string | null = null;

/**
 * Empty every application table.
 *
 * The list comes from pg_tables rather than a hardcoded array, so a table added
 * tomorrow is covered the day it lands. `cascade` is what makes this safe
 * against the schema's 26 triggers and its circular foreign keys
 * (invoices <-> billing_plan_periods): truncate does not fire row triggers, so
 * the trust ledger's append-only trigger cannot block a reset.
 */
export async function truncateAll(): Promise<void> {
  if (!cachedTableList) {
    const { rows } = await testPool.query<{ tablename: string }>(`
      select tablename from pg_tables
      where schemaname = 'public'
        and tablename not in ('schema_migrations', 'drizzle_migrations')
    `);
    if (!rows.length) return;
    cachedTableList = rows.map((r) => `public."${r.tablename}"`).join(', ');
    cachedOccupancyQuery = rows
      .map((r) => `select '${r.tablename}' as t where exists (select 1 from public."${r.tablename}")`)
      .join(' union all ');
  }

  // ONLY THE TABLES THAT ACTUALLY HOLD ROWS, which is usually a handful. The
  // existence probe is one round trip over tables that are empty or hold a few
  // rows, so it costs far less than the statements it avoids.
  const { rows: occupied } = await testPool.query<{ t: string }>(cachedOccupancyQuery as string);
  if (!occupied.length) return;

  // DELETE, not TRUNCATE.
  //
  // `truncate` allocates a NEW relfilenode for every table and every index it
  // touches, and every one of those is a `pg_class` row update. Measured on
  // this schema: `tests/auth` alone, eight spec files, grew `pg_class` from
  // 400 kB to 7.9 MB. Across a full 451-file run that is hundreds of megabytes
  // of catalog per worker database, and it is not idle weight. The checkpointer
  // has to fsync every one of those files, so checkpoints stretched to five
  // minutes and stalled every query behind them: requests that are fine in
  // isolation came back 504, connections dropped mid-request, and specs failed
  // with `socket hang up` in whichever file was unlucky. Autovacuum cannot keep
  // up either, because this suite holds locks on those tables almost
  // continuously (`skipping analyze ... lock not available` in the server log).
  //
  // `delete` writes dead tuples into the data tables instead, which autovacuum
  // handles as routine work, and leaves the catalog alone. The tables hold a
  // handful of rows each, so the delete itself is cheaper than the truncate was.
  //
  // `session_replication_role = replica` is what makes it equivalent to
  // `truncate ... cascade`: it suppresses user triggers, so the trust ledger's
  // append-only trigger cannot refuse the reset, and it suppresses the internal
  // foreign-key triggers, so the tables can be emptied in any order without
  // resolving the schema's circular references (invoices <-> billing_plan_periods).
  // `set local` reverts at commit, which matters on a pooled connection.
  //
  // `restart identity` is not carried over and nothing is lost: this schema has
  // no sequences at all, uuid primary keys throughout, so it was already a no-op.
  const targets = occupied.map((r) => `delete from public."${r.t}"`).join('; ');

  // Retried, because this deadlocks occasionally and transiently.
  //
  // Some app writes are deliberately fire-and-forget and outlive the request
  // that started them, the audit log above all, so one can still hold a row lock
  // on a table this statement has not reached while wanting one it already
  // holds. That is a genuine deadlock and Postgres correctly kills one side.
  //
  // The `beforeEach` drain plus a setImmediate turn removes the ordinary case;
  // this covers the rest. A deadlock here is never a real failure, and retrying
  // is honest: the alternative is a suite that goes red at random as it grows.
  //
  // Run on ONE checked-out client, not through `testPool.query`. A pool sends
  // each query to whatever connection is free, so a failed multi-statement
  // transaction would leave that connection idle-in-transaction while the
  // `rollback` went to a different one, and `set local` would not have been
  // unwound on the connection that still carried it.
  for (let attempt = 1; ; attempt += 1) {
    const client = await testPool.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      await client.query(targets);
      await client.query('commit');
      return;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      const code = (err as { code?: string }).code;
      // 55P03 is `lock_not_available`, raised by the lock_timeout set on this
      // pool. Retried alongside the deadlock, because both mean the same thing
      // here: something from the previous spec has not finished letting go yet.
      if ((code !== '40P01' && code !== '55P03') || attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    } finally {
      client.release();
    }
  }
}

export async function closeTestPool(): Promise<void> {
  await testPool.end();
}
