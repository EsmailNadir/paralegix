/**
 * Generated cases for `time_entries.amount_cents`, the `round(hours * rate_cents)`
 * generated column (`db/schema.sql:1316`).
 *
 * `tests/schema/constraints.test.ts` pins ONE hand-picked case (0.33 hours at
 * $3.33/hr -> 109.89 cents -> 110) proving the column rounds rather than
 * truncates. This file generates many (hours, rate_cents) pairs across a
 * seeded loop and checks each one against a value computed independently of
 * Postgres, never by asking the database to grade its own homework.
 *
 * Postgres `numeric` is exact decimal arithmetic, so the independent oracle
 * here has to avoid floating point too, or a mismatch could be the oracle's
 * fault rather than the schema's. `hours` always carries at most two decimal
 * digits (`numeric(6,2)`), so every case is generated as an integer number of
 * hour-cents; the product with the integer `rate_cents` is then an exact JS
 * integer (well inside `Number.MAX_SAFE_INTEGER` for every value generated
 * here), and only THAT integer gets divided and rounded half-up - matching
 * Postgres `round()` on a non-negative numeric, which rounds half away from
 * zero.
 */
import { randomUUID } from 'crypto';

import { testPool, createFirm, type Firm } from '../support/setupInProcess';

async function createMatter(lawFirmId: string): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, $3, $4)`,
    [id, lawFirmId, 'Rounded time matter', `REF-${id.slice(0, 8)}`],
  );
  return id;
}

/** Deterministic seeded PRNG (mulberry32), so a failing case reproduces from its seed. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Round-half-up on an exact integer product, entirely in integer arithmetic
 * (no float division ever touches a value near a rounding boundary).
 */
function expectedAmountCents(hoursCentsInt: number, rateCents: number): number {
  const product = hoursCentsInt * rateCents;
  const whole = Math.floor(product / 100);
  const remainder = product - whole * 100;
  return remainder >= 50 ? whole + 1 : whole;
}

let firm: Firm;
let matterId: string;

beforeEach(async () => {
  firm = await createFirm();
  matterId = await createMatter(firm.id);
});

describe('time_entries.amount_cents generated cases (schema.sql:1316)', () => {
  it('matches round(hours * rate_cents) across a large seeded sweep, including exact half-cent boundaries', async () => {
    const rand = mulberry32(20260901);

    const cases: Array<{ hoursCentsInt: number; rateCents: number }> = [
      { hoursCentsInt: 0, rateCents: 0 }, // zero hours, zero rate
      { hoursCentsInt: 0, rateCents: 50_000 }, // zero hours, real rate
      { hoursCentsInt: 1, rateCents: 1 }, // one cent of an hour, one cent an hour: still rounds to 0
      { hoursCentsInt: 1, rateCents: 10_000_000 }, // one cent of an hour against a huge rate
      { hoursCentsInt: 999_999, rateCents: 0 }, // the numeric(6,2) ceiling (9999.99h), zero rate
      { hoursCentsInt: 999_999, rateCents: 99_999_999 }, // the ceiling against a huge rate: large allowed total
      { hoursCentsInt: 33, rateCents: 33_300 }, // the schema.sql-pinned case: 0.33h * $333.00
    ];

    for (let i = 0; i < 60; i += 1) {
      cases.push({
        hoursCentsInt: Math.floor(rand() * 1_000_000), // 0.00 .. 9999.99 hours
        rateCents: Math.floor(rand() * 100_000_000), // $0 .. $1,000,000.00 / hr
      });
    }

    // Force products that land on EXACTLY x.50 cents: 0.50 hours at an odd rate
    // always does it, since 50 * odd is never a multiple of 100. That is the one
    // point where "round half up" and "truncate" disagree on every single case,
    // so it is worth hitting deliberately rather than hoping the random sweep
    // lands there.
    for (let k = 0; k < 10; k += 1) {
      cases.push({ hoursCentsInt: 50, rateCents: 2 * Math.floor(rand() * 1_000_000) + 1 });
    }

    // One INSERT, many rows: a single round trip, and RETURNING preserves the
    // VALUES order exactly, so it maps back onto `cases` by index.
    const values: string[] = [];
    const params: any[] = [];
    cases.forEach(({ hoursCentsInt, rateCents }, index) => {
      const base = index * 5;
      values.push(`('time', $${base + 1}, $${base + 2}, $${base + 3}, current_date, $${base + 4}, $${base + 5})`);
      params.push(randomUUID(), firm.id, matterId, (hoursCentsInt / 100).toFixed(2), rateCents);
    });

    const result = await testPool.query(
      `insert into activities (kind, id, law_firm_id, matter_id, activity_date, hours, rate_cents)
       values ${values.join(', ')}
       returning amount_cents`,
      params,
    );

    expect(result.rows).toHaveLength(cases.length);
    result.rows.forEach((row: any, index: number) => {
      const { hoursCentsInt, rateCents } = cases[index];
      const actual = Number(row.amount_cents);
      const expected = expectedAmountCents(hoursCentsInt, rateCents);
      if (actual !== expected) {
        throw new Error(
          `case ${index} (seed 20260901): hours=${(hoursCentsInt / 100).toFixed(2)} ` +
            `rate_cents=${rateCents} -> expected ${expected}, got ${actual}`,
        );
      }
    });
  });

  it('is null-safe: a missing hours or rate_cents contributes 0 to the product, not NULL', async () => {
    const noRate = await testPool.query(
      `insert into activities (kind, id, law_firm_id, matter_id, activity_date, hours)
       values ('time', $1, $2, $3, current_date, '10.00')
       returning amount_cents`,
      [randomUUID(), firm.id, matterId],
    );
    expect(Number(noRate.rows[0].amount_cents)).toBe(0);

    const noHours = await testPool.query(
      `insert into activities (kind, id, law_firm_id, matter_id, activity_date, rate_cents)
       values ('time', $1, $2, $3, current_date, 5000)
       returning amount_cents`,
      [randomUUID(), firm.id, matterId],
    );
    expect(Number(noHours.rows[0].amount_cents)).toBe(0);
  });
});
