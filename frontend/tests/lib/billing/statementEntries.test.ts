/**
 * The client portal statement: one row per invoice, payment and credit note,
 * oldest first, with a running balance. `jest.config.js` pins
 * TZ=America/Los_Angeles, which is where a UTC-midnight reading of a day-only
 * date lands on the previous day.
 *
 * Red if rows are ordered by `new Date(dayOnly)` instants (the Apr 9 credit
 * note created in the evening sorts after the Apr 10 invoice), if same-day rows
 * are not ranked invoice, payment, credit, or if the balance drifts in floating
 * dollars.
 */
import { buildStatementEntries } from '@/lib/billing/statementEntries';
import type { Invoice } from '@/types';

function inv(overrides: Partial<Invoice>): Invoice {
  return { id: 'inv-x', invoiceName: 'X', totalAmount: 0, payments: [], creditNotes: [], ...overrides } as Invoice;
}

describe('buildStatementEntries', () => {
  it('orders mixed day-only and timestamp rows by the viewer\'s calendar day', () => {
    const rows = buildStatementEntries([
      inv({
        id: 'a', invoiceName: 'April A', invoiceDate: '2026-04-09', totalAmount: 50,
        // 8pm on Apr 9 in Los Angeles, already Apr 10 in UTC.
        creditNotes: [{ id: 'cn-a', amount: 5, type: 'discount', description: '', createdBy: 'u', createdAt: '2026-04-10T03:00:00.000Z' }],
      }),
      inv({
        id: 'b', invoiceName: 'April B', invoiceDate: '2026-04-10', totalAmount: 100,
        payments: [{ amount: 40, date: '2026-04-10' }],
        creditNotes: [{ id: 'cn-b', amount: 10, type: 'write_off', description: '', createdBy: 'u', createdAt: '2026-04-10T20:00:00.000Z' }],
      }),
    ]);

    expect(rows.map((r) => [r.date, r.description, r.balance])).toEqual([
      ['Apr 9, 2026', 'Invoice: April A', 50],
      ['Apr 9, 2026', 'discount for "April A"', 45],
      ['Apr 10, 2026', 'Invoice: April B', 145],
      ['Apr 10, 2026', 'Payment for "April B"', 105],
      ['Apr 10, 2026', 'write off for "April B"', 95],
    ]);
  });

  it('ranks a same-day payment after its invoice even when the payment is listed first', () => {
    // Invoice B's payment lands on the day invoice C is issued; C is iterated
    // second, so input order alone would put B's payment first.
    const rows = buildStatementEntries([
      inv({ id: 'b', invoiceName: 'B', invoiceDate: '2026-04-01', totalAmount: 20, payments: [{ amount: 20, date: '2026-04-10' }] }),
      inv({ id: 'c', invoiceName: 'C', invoiceDate: '2026-04-10', totalAmount: 30 }),
    ]);

    expect(rows.map((r) => r.description)).toEqual([
      'Invoice: B',
      'Invoice: C',
      'Payment for "B"',
    ]);
    expect(rows.map((r) => r.balance)).toEqual([20, 50, 30]);
  });

  it('orders two credit notes on the same day by when they were created', () => {
    const rows = buildStatementEntries([
      inv({
        id: 'd', invoiceName: 'D', invoiceDate: '2026-04-10', totalAmount: 10,
        creditNotes: [
          { id: 'late', amount: 1, type: 'adjustment', label: 'Late', description: '', createdBy: 'u', createdAt: '2026-04-10T22:00:00.000Z' },
          { id: 'early', amount: 2, type: 'adjustment', label: 'Early', description: '', createdBy: 'u', createdAt: '2026-04-10T16:00:00.000Z' },
        ],
      }),
    ]);

    expect(rows.map((r) => r.description)).toEqual(['Invoice: D', 'Early for "D"', 'Late for "D"']);
  });

  it('keeps the running balance exact to the cent', () => {
    // 0.1 + 0.2 in floating dollars is 0.30000000000000004.
    const rows = buildStatementEntries([
      inv({ id: 'e', invoiceName: 'E', invoiceDate: '2026-04-01', totalAmount: 0.1 }),
      inv({ id: 'f', invoiceName: 'F', invoiceDate: '2026-04-02', totalAmount: 0.2 }),
    ]);
    expect(rows[1].balance).toBe(0.3);
  });

  it('falls back to the creation instant for an invoice with no invoice date', () => {
    const rows = buildStatementEntries([
      inv({ id: 'g', invoiceName: 'G', invoiceDate: null as never, createdAt: '2026-04-10T03:00:00.000Z', totalAmount: 5 }),
      inv({ id: 'h', invoiceName: 'H', invoiceDate: '2026-04-09', totalAmount: 7 }),
    ]);
    // G was created on Apr 9 local, the same day as H, so both are Apr 9
    // invoices and keep input order between them.
    expect(rows.map((r) => [r.date, r.description])).toEqual([
      ['Apr 9, 2026', 'Invoice: G'],
      ['Apr 9, 2026', 'Invoice: H'],
    ]);
  });

  it('gives a voided invoice no row and no balance effect', () => {
    expect(buildStatementEntries([
      inv({ id: 'v', invoiceName: 'V', invoiceDate: '2026-04-01', totalAmount: 500, status: 'voided' as never }),
    ])).toEqual([]);
  });

  it('keeps only the live invoice balance when a voided invoice sits beside it', () => {
    const rows = buildStatementEntries([
      inv({ id: 'v', invoiceName: 'V', invoiceDate: '2026-04-01', totalAmount: 500, status: 'voided' as never }),
      inv({ id: 'l', invoiceName: 'L', invoiceDate: '2026-04-02', totalAmount: 120 }),
    ]);
    expect(rows.map((r) => [r.description, r.balance])).toEqual([['Invoice: L', 120]]);
  });

  it('still applies a credit note on a live invoice', () => {
    const rows = buildStatementEntries([
      inv({
        id: 'c', invoiceName: 'C', invoiceDate: '2026-04-01', totalAmount: 100, status: 'outstanding' as never,
        creditNotes: [{ id: 'cn', amount: 30, type: 'discount', description: '', createdBy: 'u', createdAt: '2026-04-02T18:00:00.000Z' }],
      }),
    ]);
    expect(rows.map((r) => r.balance)).toEqual([100, 70]);
  });
});
