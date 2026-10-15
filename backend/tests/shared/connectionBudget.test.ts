/**
 * Connection budget derivation - pure unit tests, no database.
 *
 * `DATABASE_URL` is the Supabase session pooler (Supavisor). It refuses a new
 * client once `pool_size` connections are open for the user and database, with
 * `(EMAXCONNSESSION) max clients reached in session mode`, instead of queueing
 * it. So the pool this module derives must never be able to open more than that.
 * When it could, a page reload after an idle period opened every connection at
 * once and whole dashboard sections came back as "Couldn't load".
 *
 *   npx jest tests/shared/connectionBudget.test.ts
 */

/**
 * Supavisor's session-mode `pool_size` on the current Supabase tier. Raised from
 * the Nano default of 15 to 20 on 2026-09-16, confirmed by opening 19 concurrent
 * connections against staging where 15 used to be refused.
 */
const SUPAVISOR_SESSION_POOL_SIZE = 20;

/**
 * Connections the pool must leave for callers that do not come through it: a
 * migration run, a `psql` session, the Supabase dashboard.
 */
const HEADROOM_OUTSIDE_THE_POOL = 3;

/** The heaviest dashboard section's weight (`MAX_SECTION_WEIGHT` in dashboard.service.ts). */
const MAX_SECTION_WEIGHT = 4;

const BUDGET_ENV = ['MAX_INSTANCES', 'PG_POOL_MAX', 'PG_POOL_RESERVE', 'POOLER_CEILING_SAFE'];
const savedEnv: Record<string, string | undefined> = {};

function loadBudget(env: Record<string, string>) {
  for (const name of BUDGET_ENV) delete process.env[name];
  Object.assign(process.env, env);
  let budget: any;
  jest.isolateModules(() => {
    budget = require('../../src/shared/database/connectionBudget');
  });
  return budget;
}

beforeAll(() => {
  for (const name of BUDGET_ENV) savedEnv[name] = process.env[name];
});

afterAll(() => {
  for (const name of BUDGET_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

describe('connectionBudget', () => {
  test('the deployed topology (one instance) derives a pool the session pooler can hold', () => {
    const budget = loadBudget({ MAX_INSTANCES: '1' });

    expect(budget.BUDGET_DERIVED).toBe(true);
    // Not merely under the pool size: under it by the headroom, so a migration
    // or a psql session still has a slot while every instance is at its pool max.
    expect(budget.PG_POOL_MAX).toBeLessThanOrEqual(SUPAVISOR_SESSION_POOL_SIZE - HEADROOM_OUTSIDE_THE_POOL);
  });

  test('that pool still admits the heaviest dashboard section', () => {
    const budget = loadBudget({ MAX_INSTANCES: '1' });

    expect(budget.DASHBOARD_CONNECTION_CAPACITY).toBeGreaterThanOrEqual(MAX_SECTION_WEIGHT);
  });

  test('an explicit POOLER_CEILING_SAFE is split across instances', () => {
    const budget = loadBudget({ MAX_INSTANCES: '2', POOLER_CEILING_SAFE: '30' });

    expect(budget.PG_POOL_MAX).toBe(15);
  });

  test('a topology the ceiling cannot hold refuses to boot', () => {
    expect(() => loadBudget({ MAX_INSTANCES: '1', PG_POOL_MAX: '50' })).toThrow(/above the safe pooler ceiling/);
  });
});
