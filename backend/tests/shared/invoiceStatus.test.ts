/**
 * Unit tests for the canonical invoice status derivation.
 *
 * This module decides what an invoice is called AND what gets written into the
 * `status` column on every invoice write, so a regression here silently restates
 * the firm's books. Pure functions, no database and no auth: these run anywhere.
 */

const { deriveInvoiceStatus, isPastDue, invoiceTotalCents } = require('../../src/modules/billing/shared/invoiceStatus');

// Fixed "now" so the overdue cases can't drift with the calendar.
const NOW = new Date('2026-07-25T12:00:00.000Z');

describe('deriveInvoiceStatus', () => {
  it('reports an invoice closed by a write-off as credited, not paid', () => {
    // The firm billed $1,001, collected $10, and forgave $991. Reporting this as
    // "paid" credits the firm with money that never arrived.
    expect(
      deriveInvoiceStatus({ totalAmount: 1001, amountPaid: 10, totalWrittenOff: 991, isPaid: false }, NOW)
    ).toBe('credited');
  });

  it('reports a zero-total invoice as paid once it is marked paid', () => {
    expect(deriveInvoiceStatus({ totalAmount: 0, amountPaid: 0, totalWrittenOff: 0, isPaid: true }, NOW)).toBe('paid');
  });

  it('keeps an unmarked zero-total invoice outstanding, never overdue', () => {
    expect(
      deriveInvoiceStatus({ totalAmount: 0, amountPaid: 0, totalWrittenOff: 0, isPaid: false, dueDate: '2026-01-01' }, NOW)
    ).toBe('outstanding');
  });

  it('keeps a collected invoice paid even when part of it was written off', () => {
    // $450 of $500 collected with a $50 discount: settled by payment, not by
    // forgiveness. `isPaid` is what distinguishes the two.
    expect(
      deriveInvoiceStatus({ totalAmount: 500, amountPaid: 450, totalWrittenOff: 50, isPaid: true }, NOW)
    ).toBe('paid');
  });

  it('does not call an invoice credited while it still owes money', () => {
    // A partial credit note leaves a real balance. Only a settled balance can be
    // credited; the creditNotes clause is a tiebreak for how it settled, not a
    // trigger on its own.
    expect(
      deriveInvoiceStatus(
        { totalAmount: 200, amountPaid: 0, totalWrittenOff: 50, creditNotes: [{ amount: 50 }], dueDate: '2999-01-01' },
        NOW
      )
    ).toBe('outstanding');
  });

  it('does not depend on the stored status column', () => {
    // Legacy rows carry values outside the derived vocabulary ('draft',
    // 'partial'). The rule reads the amounts, so those rows still resolve.
    expect(
      deriveInvoiceStatus({ status: 'partial', totalAmount: 1001, amountPaid: 10, totalWrittenOff: 991 }, NOW)
    ).toBe('credited');
    expect(
      deriveInvoiceStatus({ status: 'draft', totalAmount: 500, amountPaid: 500, totalWrittenOff: 0 }, NOW)
    ).toBe('paid');
  });

  it('reports a fully collected invoice as paid', () => {
    expect(deriveInvoiceStatus({ totalAmount: 500, amountPaid: 500, totalWrittenOff: 0 }, NOW)).toBe('paid');
  });

  it('reports a part payment as partially paid', () => {
    expect(deriveInvoiceStatus({ totalAmount: 1000, amountPaid: 645, totalWrittenOff: 110 }, NOW)).toBe(
      'partially_paid'
    );
  });

  it('reports an unpaid invoice past its due day as overdue', () => {
    expect(
      deriveInvoiceStatus({ totalAmount: 600, amountPaid: 0, totalWrittenOff: 0, dueDate: '2026-06-20' }, NOW)
    ).toBe('overdue');
  });

  it('prefers the next scheduled payment date over the due date for overdue', () => {
    expect(
      deriveInvoiceStatus(
        { totalAmount: 600, amountPaid: 0, dueDate: '2026-06-20', nextPaymentDate: '2999-01-01' },
        NOW
      )
    ).toBe('outstanding');
  });

  it('leaves an unpaid invoice with no due date outstanding', () => {
    expect(deriveInvoiceStatus({ totalAmount: 600, amountPaid: 0, totalWrittenOff: 0 }, NOW)).toBe('outstanding');
  });

  it('does not call a zero-total invoice paid', () => {
    // Nothing was billed, so nothing was settled. It must not read as revenue.
    expect(deriveInvoiceStatus({ totalAmount: 0, amountPaid: 0, totalWrittenOff: 0 }, NOW)).toBe('outstanding');
  });
});

describe('isPastDue', () => {
  it('stays true for an invoice that is partially paid AND past due', () => {
    // deriveInvoiceStatus buckets this as 'partially_paid', which short-circuits
    // before the overdue branch, so the two must not be treated as equivalent.
    const invoice = { totalAmount: 1000, amountPaid: 400, dueDate: '2026-06-20' };
    expect(deriveInvoiceStatus(invoice, NOW)).toBe('partially_paid');
    expect(isPastDue(invoice, NOW)).toBe(true);
  });

  it('is false once the balance is settled', () => {
    expect(isPastDue({ totalAmount: 500, amountPaid: 500, dueDate: '2026-06-20' }, NOW)).toBe(false);
  });

  it('is false without a due date', () => {
    expect(isPastDue({ totalAmount: 500, amountPaid: 0 }, NOW)).toBe(false);
  });
});

describe('invoiceTotalCents', () => {
  it('preserves canonical total including zero and does not fall back to flat fees', () => {
    expect(invoiceTotalCents({ totalAmount: 0, flatFeesAmount: 55 })).toBe(0);
  });

  it('does not add flat fees on top of a stored total', () => {
    expect(invoiceTotalCents({ totalAmount: 163.17, flatFeesAmount: 14.67 })).toBe(16317);
  });

  it('preserves negative totals', () => {
    expect(invoiceTotalCents({ totalAmount: -25.5 })).toBe(-2550);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
