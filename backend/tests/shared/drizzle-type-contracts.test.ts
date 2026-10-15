/* This spec intentionally exercises the unrestricted generated client to verify
 * the generated Drizzle types. It is not application query code. */
/* eslint-disable no-restricted-syntax, paralegix/safe-drizzle-boundary */

/**
 * Drizzle must agree with the raw `pg` path, column type for column type.
 *
 * These are not tests of Drizzle. They pin the FOUR places where a Drizzle read
 * could silently disagree with the `pool.query` reads that make up the rest of
 * the application. A disagreement here does not throw -- it produces a subtly
 * different value shape, so a repository half-converted to Drizzle would emit a
 * different API response than one that is not.
 *
 * Two of the four are wrong straight out of `drizzle-kit pull` and are corrected
 * by db/normalize-drizzle-schema.ts. If someone regenerates the schema without
 * running the normalizer, these fail.
 *
 * TWO THINGS THIS FILE USED TO GET WRONG, both of which made it useless in CI.
 *
 * It required `../../dist/...`, so it only ran after `npm run build`. CI never
 * builds before the unit suite, so every case here died with "Cannot find module
 * '../../dist/shared/database/db'" on every run. ts-jest compiles the source
 * tree anyway, so `src/` is the same code without the build step.
 *
 * And all three data cases opened with `if (!rows[0]) return;` against a
 * database nothing had seeded. On a truncated test database that is an early
 * return, not an assertion: the case reports green having compared nothing. The
 * rows are seeded below so each one actually runs, and the guards are gone.
 */

const { testPool, closeTestPool } = require('../support/db');

// AFTER the require above, which is what points `DATABASE_URL` at this worker's
// test database. `src/shared/database/db` resolves its connection string at
// module load, so the order is load-bearing.
const { pool } = require('../../src/shared/database/db');
const { db, schema } = require('../../src/shared/database/drizzleClient');
const { eq } = require('drizzle-orm');
const { randomUUID } = require('crypto');

const FIRM_ID = randomUUID();
const CLIENT_ID = randomUUID();
let timeEntryId: string;
let invoiceId: string;

describe('drizzle type contracts', () => {
  // Seeded through plain SQL on the test pool rather than through a repository:
  // a fixture built by the code under test cannot expose a fault in that code.
  beforeAll(async () => {
    await testPool.query(
      `insert into law_firms (id, name, plan_id, billing_status)
       values ($1, '__TEST__ drizzle contracts firm', 'enterprise', 'comped')`,
      [FIRM_ID],
    );
    await testPool.query(
      `insert into clients (id, law_firm_id, name, client_type)
       values ($1, $2, 'Contract Client', 'person')`,
      [CLIENT_ID, FIRM_ID],
    );
    // rate_cents is set so `amount_cents`, a generated column, is non-zero and
    // the money case compares a real figure.
    const entry = await testPool.query(
      `insert into activities (kind, law_firm_id, client_id, activity_date, hours, rate_cents, description)
       values ('time', $1, $2, '2026-03-10', 1.50, 25000, 'Contract fixture') returning id`,
      [FIRM_ID, CLIENT_ID],
    );
    timeEntryId = entry.rows[0].id;
    const invoice = await testPool.query(
      `insert into invoices (law_firm_id, client_id, client_context_id, context_type,
                             invoice_number, status, total_cents, invoice_date, due_date)
       values ($1, $2, $2, 'client', $3, 'outstanding', 37500, current_date, current_date + 30)
       returning id`,
      [FIRM_ID, CLIENT_ID, `INV-${FIRM_ID.slice(0, 8)}`],
    );
    invoiceId = invoice.rows[0].id;
  });

  afterAll(async () => {
    // law_firms cascades to both fixture rows.
    await testPool.query('delete from law_firms where id = $1', [FIRM_ID]);
    await pool.end();
    await closeTestPool();
  });

  test("day-only date columns are 'YYYY-MM-DD' strings, not Date objects", async () => {
    const { rows } = await pool.query(
      `select id, activity_date as entry_date from activities where kind = 'time' and id = $1`, [timeEntryId]
    );
    const raw = rows[0];

    // The premise: db.js registers a type parser for oid 1082 so a day-only date
    // never goes through new Date() and cannot shift by a timezone.
    expect(typeof raw.entry_date).toBe('string');
    expect(raw.entry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const [viaDrizzle] = await db.select().from(schema.activities)
      .where(eq(schema.activities.id, raw.id)).limit(1);

    expect(typeof viaDrizzle.activityDate).toBe('string');
    expect(viaDrizzle.activityDate).toBe(raw.entry_date);
  });

  test('timestamptz columns are Date objects on both paths', async () => {
    const { rows } = await pool.query(
      `select id, created_at from activities where kind = 'time' and id = $1`, [timeEntryId]
    );
    const raw = rows[0];

    // node-pg returns a Date for timestamptz, and the output shapers
    // (`sqlRowToEntity`, the per-module toIso) branch on `instanceof Date`.
    // drizzle-kit pull emits mode:'string' here, which would return an ISO string
    // instead; the normalizer rewrites all 222 of them to mode:'date'.
    expect(raw.created_at).toBeInstanceOf(Date);

    const [viaDrizzle] = await db.select().from(schema.activities)
      .where(eq(schema.activities.id, raw.id)).limit(1);

    expect(viaDrizzle.createdAt).toBeInstanceOf(Date);
    expect(viaDrizzle.createdAt.toISOString()).toBe(raw.created_at.toISOString());
  });

  test('money is integer cents and survives the round trip', async () => {
    const { rows } = await pool.query(
      'select id, total_cents from invoices where id = $1', [invoiceId]
    );
    const raw = rows[0];

    // node-pg hands back bigint as a STRING, because a bigint does not fit a JS
    // number in the general case.
    expect(typeof raw.total_cents).toBe('string');

    const [viaDrizzle] = await db.select().from(schema.invoices)
      .where(eq(schema.invoices.id, raw.id)).limit(1);

    // Compare numerically, then pin the mode separately. A String()-on-both-sides
    // comparison would pass under mode 'number', 'bigint' AND 'string', so on its
    // own it proves nothing about which one is configured.
    expect(Number(viaDrizzle.totalCents)).toBe(Number(raw.total_cents));
    expect(typeof viaDrizzle.totalCents).toBe('number');
  });

  test('generated columns are marked so inserts cannot write them', () => {
    // The database rejects a write to a generated column, so the schema has to
    // know they are generated or an insert builds invalid SQL.
    expect(schema.invoices.balanceDueCents.generated).toBeTruthy();
    expect(schema.activities.amountCents.generated).toBeTruthy();
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
