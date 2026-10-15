/**
 * The three invoice child-table date columns are real `date` columns.
 *
 * They were `text`, holding (per the schema comment they carried) "either
 * 'YYYY-MM-DD' or a full ISO string". That ambiguity is Firestore residue, and
 * it cost more than it looks:
 *
 *   - Two indexes existed on `left(col, 10)` rather than on the column, because
 *     a prefix was the only thing safe to compare.
 *   - `dashboard.service.ts` guarded its month filter with a regex
 *     (`~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'`) and then wrapped the column in
 *     `to_date(left(col, 10), 'YYYY-MM-DD')` before it could compare it.
 *   - `invoices.repository.ts` compared with `left(p.payment_date, 10) between`.
 *   - A row could hold `'2026-03-15'` and `'2026-03-15T14:00:00.000Z'` for the
 *     same day, so `= '2026-03-15'` matched one and missed the other.
 *
 * Note what was NOT wrong, so nobody "fixes" it twice: ORDER BY was fine on
 * text. ISO 8601 sorts lexically in chronological order, and a day-only string
 * sorts immediately before any timestamp on the same day, so a mixed column
 * still ordered correctly. Equality and type safety are the real defects.
 *
 * WHAT MAKES THESE GO RED: reverting any of the three columns to `text`, or
 * letting a writer put a non-day-only value back into one. The second is the
 * one worth stating, because the column type alone does not stop a caller
 * sending an ISO timestamp; Postgres casts it silently. The specs below assert
 * the API reads back a day-only string either way.
 *
 * Every value in both the local and staging databases was already a clean
 * `YYYY-MM-DD` or NULL when the columns were converted (checked before writing
 * the migration), so the conversion was lossless on real data.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  createInvoice,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;

beforeEach(async () => {
  firm = await createFirm();
});

/** The `date` type as Postgres reports it in information_schema. */
async function columnType(table: string, column: string): Promise<string> {
  const { rows } = await testPool.query(
    `select data_type from information_schema.columns
      where table_schema = 'public' and table_name = $1 and column_name = $2`,
    [table, column],
  );
  return rows[0]?.data_type ?? '(missing)';
}

describe('invoice child-table date columns are typed', () => {
  it.each([
    ['invoice_payments', 'payment_date'],
    ['invoice_expected_payments', 'due_date'],
    ['invoice_line_items', 'line_date'],
  ])('%s.%s is a date column, not text', async (table, column) => {
    expect(await columnType(table, column)).toBe('date');
  });

  it('rejects a value that is not a date at all', async () => {
    // The point of the type. As `text` this insert succeeded and the garbage
    // sat in the column until something tried to compare it.
    const client = await createPersonClient(firm.id);
    const invoice = await createInvoice(firm.id, client.id);
    await expect(
      testPool.query(
        `insert into invoice_payments (id, invoice_id, law_firm_id, amount_cents, payment_date)
         values ($1, $2, $3, 100, 'not-a-date')`,
        [randomUUID(), invoice.id, firm.id],
      ),
    ).rejects.toMatchObject({ code: '22007' });
  });

  it('stores a full ISO timestamp as the day it falls on', async () => {
    // Postgres casts rather than rejects, so this documents what a caller that
    // still sends an ISO string gets: the date, with the time dropped. Before
    // the conversion the whole string was kept and every reader had to slice it.
    const client = await createPersonClient(firm.id);
    const invoice = await createInvoice(firm.id, client.id);
    const id = randomUUID();
    await testPool.query(
      `insert into invoice_payments (id, invoice_id, law_firm_id, amount_cents, payment_date)
       values ($1, $2, $3, 100, '2026-03-15T14:30:00.000Z')`,
      [id, invoice.id, firm.id],
    );

    const { rows } = await testPool.query(
      `select payment_date from invoice_payments where id = $1`, [id],
    );
    // node-pg parses oid 1082 into a raw 'YYYY-MM-DD' string (see db.ts), so a
    // day-only column never becomes a Date and never shifts timezone.
    expect(rows[0].payment_date).toBe('2026-03-15');
  });

  it('matches a day-only equality even for a row written as a timestamp', async () => {
    // THE defect the type fixes. As text, `payment_date = '2026-03-15'` matched
    // the first row and missed the second, though both are the same day. Every
    // call site worked around it with `left(payment_date, 10)`.
    const client = await createPersonClient(firm.id);
    const invoice = await createInvoice(firm.id, client.id);
    for (const [d, cents] of [
      ['2026-03-15', 100],
      ['2026-03-15T14:30:00.000Z', 200],
    ] as const) {
      await testPool.query(
        `insert into invoice_payments (id, invoice_id, law_firm_id, amount_cents, payment_date)
         values ($1, $2, $3, $4, $5)`,
        [randomUUID(), invoice.id, firm.id, cents, d],
      );
    }

    const { rows } = await testPool.query(
      `select count(*)::int as n from invoice_payments
        where invoice_id = $1 and payment_date = $2`,
      [invoice.id, '2026-03-15'],
    );
    expect(rows[0].n).toBe(2);
  });

  it('normalizes a date a text column would have mis-sorted', async () => {
    // '2026-3-5' is a legal date and an illegal 'YYYY-MM-DD' string. As text it
    // was stored verbatim and sorted after '2026-04-01', because '3' > '0' at
    // the fifth character. The column now stores 2026-03-05 and it lands in
    // March, which is the month a range query has to find it in.
    const client = await createPersonClient(firm.id);
    const invoice = await createInvoice(firm.id, client.id);
    await testPool.query(
      `insert into invoice_payments (id, invoice_id, law_firm_id, amount_cents, payment_date)
       values ($1, $2, $3, 100, '2026-3-5')`,
      [randomUUID(), invoice.id, firm.id],
    );

    const { rows } = await testPool.query(
      `select payment_date, (payment_date >= $2 and payment_date < $3) as in_march
         from invoice_payments where invoice_id = $1`,
      [invoice.id, '2026-03-01', '2026-04-01'],
    );
    expect(rows[0].payment_date).toBe('2026-03-05');
    expect(rows[0].in_march).toBe(true);
  });
});
