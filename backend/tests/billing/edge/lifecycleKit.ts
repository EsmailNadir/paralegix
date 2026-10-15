/**
 * Shared seeding and the money invariants every payment-lifecycle spec in this
 * folder asserts after each mutation.
 *
 * `assertInvoiceInvariants` recomputes everything from the child rows and the
 * invoice row in Postgres, never from a response body, so it cannot agree with a
 * bug by sharing its arithmetic: the payment sum comes from `invoice_payments`,
 * the write-off sum from `invoice_adjustments`, and the expected status from an
 * independent restatement of the status rules.
 */
import {
  testPool,
  createFirm,
  createInvoice,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
} from '../../support/setupInProcess';

export interface World {
  firm: Firm;
  owner: Actor;
  clientId: string;
  invoiceId: string;
  base: string;
  inv: string;
}

/** A firm, an owner, a client with an email (receipts need one) and one invoice. */
export async function seedWorld(totalCents = 100_000, planId: string = 'enterprise'): Promise<World> {
  const firm = await createFirm({ planId });
  const owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: 'Lifecycle Client', email: 'lifecycle-client@example.test' });
  const invoice = await createInvoice(firm.id, client.id, { totalCents });
  const base = `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
  return { firm, owner, clientId: client.id, invoiceId: invoice.id, base, inv: `${base}/${invoice.id}` };
}

/** A second invoice for the same client. */
export async function addInvoice(w: World, totalCents: number) {
  const invoice = await createInvoice(w.firm.id, w.clientId, { totalCents });
  return { invoiceId: invoice.id, inv: `${w.base}/${invoice.id}` };
}

export interface InvoiceRow {
  total_cents: string;
  amount_paid_cents: string;
  total_written_off_cents: string;
  balance_due_cents: string;
  is_paid: boolean;
  paid_date: Date | null;
  status: string;
  next_payment_date: string | null;
}

export async function invoiceRow(invoiceId: string): Promise<InvoiceRow> {
  const { rows } = await testPool.query(
    `select total_cents, amount_paid_cents, total_written_off_cents, balance_due_cents,
            is_paid, paid_date, status, next_payment_date
       from invoices where id = $1`,
    [invoiceId],
  );
  if (rows.length !== 1) throw new Error(`invoice ${invoiceId} not found`);
  return rows[0];
}

export async function paymentRows(invoiceId: string) {
  const { rows } = await testPool.query(
    `select sort_order, amount_cents, payment_date, payment_source, trust_transaction_id,
            stripe_payment_intent_id, stripe_refunded_cents, note
       from invoice_payments where invoice_id = $1 order by sort_order`,
    [invoiceId],
  );
  return rows.map((r: any) => ({
    ...r,
    cents: Number(r.amount_cents),
    refunded: Number(r.stripe_refunded_cents),
  }));
}

export async function creditCents(invoiceId: string) {
  const { rows } = await testPool.query(
    `select coalesce(sum(amount_cents), 0)::bigint as c
       from invoice_adjustments where invoice_id = $1 and direction = 'credit'`,
    [invoiceId],
  );
  return Number(rows[0].c);
}

/**
 * Every figure the invoice carries has to agree with the rows behind it.
 * `allowExcess` is for specs that deliberately drive an invoice past its total
 * and assert that outcome themselves; `ignorePaidDate` is for specs about another
 * property that do not exercise the settlement date.
 */
export async function assertInvoiceInvariants(
  invoiceId: string,
  opts: { allowExcess?: boolean; ignorePaidDate?: boolean } = {},
) {
  const row = await invoiceRow(invoiceId);
  const payments = await paymentRows(invoiceId);
  const total = Number(row.total_cents);
  const paid = Number(row.amount_paid_cents);
  const written = Number(row.total_written_off_cents);
  const sum = payments.reduce((s: number, p: any) => s + p.cents, 0);

  // amount_paid is exactly what the payment rows add up to.
  expect({ label: 'amount_paid equals the sum of payment rows', paid }).toEqual({
    label: 'amount_paid equals the sum of payment rows', paid: sum,
  });
  // total_written_off is exactly what the credit rows add up to.
  expect({ label: 'written off equals the sum of credit rows', written }).toEqual({
    label: 'written off equals the sum of credit rows', written: await creditCents(invoiceId),
  });
  // The generated balance column is the database's own arithmetic.
  expect(Number(row.balance_due_cents)).toBe(total - paid - written);
  if (!opts.allowExcess) {
    expect({ label: 'paid plus written off never passes the total', over: paid + written > total })
      .toEqual({ label: 'paid plus written off never passes the total', over: false });
  }
  if (row.status !== 'voided') {
    const remaining = total - paid - written;
    const settled = remaining <= 0 && total > 0;
    // The flag follows the balance, in both directions. It records that cash
    // settled the invoice, so a write-off that cleared the balance may leave it
    // unset (the invoice then reads credited); every other invoice sets it exactly
    // when the balance is gone.
    if (!(settled && written > 0)) {
      expect({ label: 'is_paid follows the balance', isPaid: row.is_paid })
        .toEqual({ label: 'is_paid follows the balance', isPaid: settled });
    }
    // A settled invoice reads paid, or credited when a write-off helped settle it
    // (a separate spec pins which); an unsettled one reads by what was collected (overdue is the
    // time-dependent form of outstanding; specs with a past due date pin it).
    const okStatuses = settled
      ? (written > 0 ? ['paid', 'credited'] : ['paid'])
      : (paid > 0 ? ['partially_paid'] : ['outstanding', 'overdue']);
    expect({ label: 'status matches the amounts', ok: okStatuses.includes(row.status), status: row.status })
      .toEqual({ label: 'status matches the amounts', ok: true, status: row.status });
  }
  // A settlement date only exists while the invoice is settled.
  if (!row.is_paid && !opts.ignorePaidDate) {
    expect({ label: 'no paid date on an unpaid invoice', paidDate: row.paid_date })
      .toEqual({ label: 'no paid date on an unpaid invoice', paidDate: null });
  }
  return { row, payments };
}

export const dollars = (cents: number) => cents / 100;
