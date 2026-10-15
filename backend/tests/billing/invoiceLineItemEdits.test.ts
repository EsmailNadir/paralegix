/**
 * Editing the lines on an issued invoice.
 *
 * `PATCH .../:invoiceId/line-items` is a replace-all: the caller sends the
 * complete surviving set for each of the three kinds and the service rebuilds
 * every number hanging off them. That makes it the one route that can put an
 * invoice's stated total out of step with the lines printed underneath it, and
 * a client reading such a bill has no way to tell.
 *
 * Three properties are worth more than the rest, and each has its own group:
 *
 *   - `total_cents` always equals the sum of `invoice_line_items.amount_cents`
 *     (plus tax, covered in invoiceTax.test.ts). Every case here checks the
 *     stored rows, not just the response body.
 *   - an hourly line's amount is recomputed from hours x rate, so a caller
 *     cannot state a figure its own hours do not support.
 *   - lowering a bill under what has already been collected is a refusal by
 *     default, because it turns a debt into a refund the firm owes.
 *
 * Figures are picked so the right answer and the plausible wrong one differ.
 * 2.3 hours at $33.33 is 7,665.9 cents: rounded it is 7,666, truncated 7,665.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  memberWith,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { randomUUID } from 'crypto';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let invoiceId: string;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
const onInvoice = (suffix = '') => `${B()}/${invoiceId}${suffix}`;

/** Replace the invoice's lines. Omitted kinds are sent empty, as the route requires. */
function patchLines(body: Record<string, unknown>) {
  return owner.api.patch(onInvoice('/line-items')).send({
    timeEntries: [], flatFees: [], expenses: [], ...body,
  });
}

/** The stored money columns, including the generated balance. */
async function row(id = invoiceId) {
  const { rows } = await testPool.query(
    `select total_cents, total_hours, flat_fees_amount_cents, amount_paid_cents,
            balance_due_cents, is_paid, paid_date, status
       from invoices where id = $1`,
    [id],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** The persisted lines, which is what the invoice prints. */
async function lines(id = invoiceId) {
  const { rows } = await testPool.query(
    `select kind, description, quantity, rate_cents, amount_cents
       from invoice_line_items where invoice_id = $1 order by kind, sort_order`,
    [id],
  );
  return rows;
}

const lineTotalCents = async (id = invoiceId) =>
  (await lines(id)).reduce((sum: number, l: any) => sum + Number(l.amount_cents), 0);

/** The instalment schedule, in the order the client is asked to pay it. */
async function installments(id = invoiceId) {
  const { rows } = await testPool.query(
    `select amount_cents, due_date, status, matched_payment_index
       from invoice_expected_payments where invoice_id = $1 order by sort_order`,
    [id],
  );
  return rows;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Edited Client' });

  const created = await owner.api.post(B()).send({
    invoiceName: 'Editable Invoice',
    invoiceDate: '2026-03-01',
    dueDate: '2026-03-31',
    totalAmount: 1000,
    flatFeesAmount: 1000,
    flatFees: [{ description: 'Original fee', amount: 1000 }],
  });
  expect(created.status).toBe(201);
  invoiceId = created.body.invoice.id;
  await drainEvents();
});

describe('what the lines add up to', () => {
  it('recomputes an hourly line from hours x rate, ignoring the amount sent', async () => {
    // The caller states 999 for work that is worth 76.66. Trusting it would
    // print two hours and a rate that do not multiply to the figure beside
    // them, which is exactly the kind of bill a client disputes and a firm
    // cannot defend.
    const res = await patchLines({
      timeEntries: [{ description: 'Drafting', hours: 2.3, rate: 33.33, amount: 999 }],
    });

    expect(res.status).toBe(200);
    const [line] = await lines();
    // 2.3 x 3,333 cents = 7,665.9, rounded to 7,666. Truncating stores 7,665
    // and every hourly line on every invoice is a cent light.
    expect(Number(line.amount_cents)).toBe(7666);
    expect(Number(line.quantity)).toBe(2.3);
    expect(Number(line.rate_cents)).toBe(3333);
    expect(Number((await row()).total_cents)).toBe(7666);
  });

  it('takes a flat fee and an expense at the amount sent, since neither has a quantity', async () => {
    const res = await patchLines({
      flatFees: [{ description: 'Filing fee', amount: 250.25 }],
      expenses: [{ description: 'Courier', amount: 19.99 }],
    });

    expect(res.status).toBe(200);
    const stored = await lines();
    expect(stored.map((l: any) => [l.kind, Number(l.amount_cents)]))
      .toEqual([['expense', 1999], ['flat_fee', 25_025]]);
    // flat_fees_amount_cents is tracked separately from the total and feeds the
    // legacy "flat fees only" total fallback, so a stale value there resurfaces
    // as a wrong balance on invoices whose total is 0.
    expect(Number((await row()).flat_fees_amount_cents)).toBe(25_025);
  });

  it('makes the stored total equal the sum of the stored lines', async () => {
    await patchLines({
      timeEntries: [{ description: 'Drafting', hours: 2.3, rate: 33.33 }],
      flatFees: [{ description: 'Filing fee', amount: 250.25 }],
      expenses: [{ description: 'Courier', amount: 19.99 }],
    });

    // 7,666 + 25,025 + 1,999. The invariant the whole route exists to keep: a
    // total that disagrees with the lines beneath it is a wrong bill that looks
    // completely normal on screen.
    expect(await lineTotalCents()).toBe(34_690);
    expect(Number((await row()).total_cents)).toBe(34_690);
    expect(Number((await row()).balance_due_cents)).toBe(34_690);
  });

  it('bills the hours the lines carry, not the hours previously invoiced', async () => {
    await patchLines({
      timeEntries: [
        { description: 'Drafting', hours: 2.3, rate: 33.33 },
        { description: 'Review', hours: 1.2, rate: 33.33 },
      ],
    });

    // total_hours drives the hours line on the invoice and the realisation
    // reports. 1.2 x 3,333 = 3,999.6 -> 4,000, so the money is 11,666.
    expect(Number((await row()).total_hours)).toBeCloseTo(3.5, 6);
    expect(Number((await row()).total_cents)).toBe(11_666);
  });
});

describe('money field overflow on a line-item edit', () => {
  // `hours`, `rate` and `amount` in invoiceLineInputSchema are each multiplied
  // into integer cents and written to a `bigint` column (`amount_cents`,
  // `rate_cents`). A merely huge but FINITE number (e.g. 1e17) is
  // `Number.isFinite`, survives Zod's base coercion unchanged, and needs no
  // wire trick to arrive intact through ordinary object-mode JSON
  // serialization - it only fails once the *100 conversion (or, for an
  // hourly line, the hours x rate recompute) pushes the value past bigint's
  // ~9.223e18 range. Before the fix, each case below reached the database as
  // a raw "value out of range for type bigint" error and answered 500
  // instead of a clean 400.
  it('rejects a huge but finite rate on an hourly line instead of crashing the recompute', async () => {
    const res = await patchLines({
      timeEntries: [{ description: 'Drafting', hours: 2.3, rate: 1e17 }],
    });

    expect(res.status).toBe(400);
    // The invoice keeps its ORIGINAL fixture line untouched: a validation
    // failure must refuse before any write, not clear the lines and leave
    // an empty invoice.
    expect((await lines()).map((l: any) => l.description)).toEqual(['Original fee']);
  });

  it('rejects a huge but finite hours value even with an ordinary rate', async () => {
    // Capping `rate` alone does not close this: hours x (a capped rate x 100)
    // can still overflow bigint if hours itself is unbounded, so hours needs
    // its own cap independent of the rate cap.
    const res = await patchLines({
      timeEntries: [{ description: 'Drafting', hours: 1e13, rate: 100 }],
    });

    expect(res.status).toBe(400);
    // The invoice keeps its ORIGINAL fixture line untouched: a validation
    // failure must refuse before any write, not clear the lines and leave
    // an empty invoice.
    expect((await lines()).map((l: any) => l.description)).toEqual(['Original fee']);
  });

  it('rejects a huge but finite amount on a flat-fee line, which is written directly', async () => {
    // Unlike a time-entry line, a flat-fee/expense line's `amount` is taken as
    // sent rather than recomputed, so it is the only field standing between
    // the caller and `amount_cents`.
    const res = await patchLines({
      flatFees: [{ description: 'Filing fee', amount: 1e17 }],
    });

    expect(res.status).toBe(400);
    // The invoice keeps its ORIGINAL fixture line untouched: a validation
    // failure must refuse before any write, not clear the lines and leave
    // an empty invoice.
    expect((await lines()).map((l: any) => l.description)).toEqual(['Original fee']);
  });

  it('accepts a rate and an amount right at the documented maximum', async () => {
    const res = await patchLines({
      flatFees: [{ description: 'At the cap', amount: 1_000_000_000 }],
    });

    expect(res.status).toBe(200);
    const [line] = await lines();
    expect(Number(line.amount_cents)).toBe(100_000_000_000);
  });

  it('rejects an amount one dollar past the documented maximum', async () => {
    const res = await patchLines({
      flatFees: [{ description: 'One past the cap', amount: 1_000_000_001 }],
    });

    expect(res.status).toBe(400);
    // The invoice keeps its ORIGINAL fixture line untouched: a validation
    // failure must refuse before any write, not clear the lines and leave
    // an empty invoice.
    expect((await lines()).map((l: any) => l.description)).toEqual(['Original fee']);
  });
});

describe('lowering a bill under what has been collected', () => {
  /** Collect $400 against the $1,000 invoice. */
  async function payFourHundred() {
    const paid = await owner.api.put(onInvoice('/payment')).send({
      paymentAmount: 400, paidDate: '2026-03-05',
    });
    expect(paid.status).toBe(200);
    expect(Number((await row()).amount_paid_cents)).toBe(40_000);
  }

  it('refuses and names the credit the edit would create', async () => {
    await payFourHundred();

    const res = await patchLines({ flatFees: [{ description: 'Reduced fee', amount: 250 }] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVOICE_TOTAL_BELOW_SETTLED');
    // The figure the firm has to hand back. Stated in the refusal so the UI can
    // put a number in front of whoever is about to confirm it.
    expect(res.body.details).toMatchObject({
      newTotal: 250, amountPaid: 400, totalWrittenOff: 0, creditAmount: 150,
    });
  });

  it('writes nothing when it refuses', async () => {
    await payFourHundred();

    await patchLines({ flatFees: [{ description: 'Reduced fee', amount: 250 }] });

    // The refusal happens inside the row-locked transaction, after the new
    // lines have been assembled. A half-applied edit would leave the original
    // total against replaced lines, which is the worst of both.
    const stored = await row();
    expect(Number(stored.total_cents)).toBe(100_000);
    expect(Number(stored.balance_due_cents)).toBe(60_000);
    expect((await lines()).map((l: any) => l.description)).toEqual(['Original fee']);
  });

  it('performs the edit when the caller acknowledges the overpayment', async () => {
    await payFourHundred();

    const res = await patchLines({
      flatFees: [{ description: 'Reduced fee', amount: 250 }],
      acknowledgeOverpayment: true,
    });

    expect(res.status).toBe(200);
    const stored = await row();
    expect(Number(stored.total_cents)).toBe(25_000);
    expect(Number(stored.amount_paid_cents)).toBe(40_000);
    // Negative on purpose: `balance_due_cents` is generated as
    // total - paid - written off, so the database is now recording that the
    // firm holds $150 of the client's money. An implementation that clamped
    // this at zero would hide a refund the firm owes.
    expect(Number(stored.balance_due_cents)).toBe(-15_000);
    expect(stored.is_paid).toBe(true);
  });

  it('leaves an unpaid invoice free to be lowered without any acknowledgement', async () => {
    // Nothing collected, so nothing to refund and no confirmation to demand.
    const res = await patchLines({ flatFees: [{ description: 'Reduced fee', amount: 250 }] });

    expect(res.status).toBe(200);
    expect(Number((await row()).balance_due_cents)).toBe(25_000);
  });
});

describe('settlement flipping either way', () => {
  it('reopens a settled invoice when the edit raises the total, and clears its paid date', async () => {
    const paid = await owner.api.put(onInvoice('/payment')).send({ isPaid: true, paidDate: '2026-03-05' });
    expect(paid.status).toBe(200);
    expect((await row()).is_paid).toBe(true);

    const res = await patchLines({ flatFees: [{ description: 'Revised fee', amount: 1500 }] });

    expect(res.status).toBe(200);
    const stored = await row();
    expect(stored.is_paid).toBe(false);
    // A retained paid_date would date a settlement that no longer holds, and
    // the $500 now owing would sit behind a "Paid on 5 March" label.
    expect(stored.paid_date).toBeNull();
    expect(Number(stored.balance_due_cents)).toBe(50_000);
  });

  it('settles an invoice when the edit drops the total to exactly what was collected', async () => {
    const paid = await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 400 });
    expect(paid.status).toBe(200);
    expect((await row()).is_paid).toBe(false);

    const res = await patchLines({ flatFees: [{ description: 'Reduced fee', amount: 400 }] });

    expect(res.status).toBe(200);
    const stored = await row();
    expect(Number(stored.balance_due_cents)).toBe(0);
    // Exactly settled, so no acknowledgement is required and the invoice must
    // stop being chased.
    expect(stored.is_paid).toBe(true);
  });
});

describe('the instalment schedule after an edit', () => {
  /** A four-instalment plan over the $1,000 invoice, with the first one collected. */
  async function planWithFirstInstalmentPaid() {
    const plan = await owner.api.post(onInvoice('/payment-plan')).send({
      installmentAmount: 250, frequencyDays: 30, planStartDate: '2026-04-01',
    });
    expect(plan.status).toBe(200);
    expect(await installments()).toHaveLength(4);

    const paid = await owner.api.put(onInvoice('/payment')).send({
      paymentAmount: 250, paidDate: '2026-04-01', installmentIndex: 0,
    });
    expect(paid.status).toBe(200);
    const after = await installments();
    expect(after[0].status).toBe('paid');
    expect(after[0].matched_payment_index).toBe(0);
    return after;
  }

  it('keeps the collected instalment and refits only the pending tail', async () => {
    const before = await planWithFirstInstalmentPaid();

    // Drop the bill to $600. $250 is already collected, so $350 remains to be
    // scheduled across the pending instalments.
    const res = await patchLines({ flatFees: [{ description: 'Reduced fee', amount: 600 }] });
    expect(res.status).toBe(200);

    const after = await installments();
    // The collected instalment survives verbatim, with the payment it is tied
    // to. Regenerating the whole schedule would silently revert it to pending
    // and put an instalment the client has already paid back on their statement
    // as overdue, dated before today.
    expect(after[0]).toMatchObject({
      status: 'paid', amount_cents: '25000', matched_payment_index: 0, due_date: before[0].due_date,
    });
    // The pending tail refits to the plan's own instalment size: 250 + 100.
    expect(after.slice(1).map((i: any) => [Number(i.amount_cents), i.status]))
      .toEqual([[25_000, 'pending'], [10_000, 'pending']]);
  });

  it('refits the pending instalments to sum EXACTLY to the new balance', async () => {
    await planWithFirstInstalmentPaid();

    await patchLines({ flatFees: [{ description: 'Reduced fee', amount: 600 }] });

    const after = await installments();
    const pending = after.filter((i: any) => i.status !== 'paid')
      .reduce((sum: number, i: any) => sum + Number(i.amount_cents), 0);
    // The property the schedule exists to hold. A tail summing to less leaves a
    // balance nobody is scheduled to pay and the invoice ages quietly; more, and
    // the client is asked for money the invoice does not claim.
    expect(pending).toBe(Number((await row()).balance_due_cents));
    expect(pending).toBe(35_000);
    // And the whole schedule still accounts for the whole bill.
    expect(after.reduce((sum: number, i: any) => sum + Number(i.amount_cents), 0)).toBe(60_000);
  });

  it('reuses the dates the client was already given rather than restarting the plan', async () => {
    const before = await planWithFirstInstalmentPaid();

    await patchLines({ flatFees: [{ description: 'Reduced fee', amount: 600 }] });

    const after = await installments();
    // A shortened schedule keeps the leading due dates it had. Restarting from
    // the plan start date would move every remaining payment earlier, several
    // of them into the past.
    expect(after.map((i: any) => i.due_date)).toEqual(before.slice(0, 3).map((i: any) => i.due_date));
  });

  it('drops the plan entirely when the edit clears the balance', async () => {
    await planWithFirstInstalmentPaid();

    // Reduce the bill to exactly what has been collected. Nothing is left to
    // schedule, so there is no plan to keep.
    const res = await patchLines({ flatFees: [{ description: 'Reduced fee', amount: 250 }] });
    expect(res.status).toBe(200);

    const after = await installments();
    // The collected instalment is retained as the plan's history; nothing is
    // left pending.
    expect(after.filter((i: any) => i.status !== 'paid')).toHaveLength(0);
    const { rows } = await testPool.query(
      'select next_payment_date from invoices where id = $1', [invoiceId],
    );
    // No pending instalment means nothing to chase, so the invoice must stop
    // reporting a next payment date or it reads as overdue forever.
    expect(rows[0].next_payment_date).toBeNull();
  });
});

describe('what the route refuses outright', () => {
  it('refuses to edit one invoice out of a split group', async () => {
    // A split invoice carries one payer's share and its siblings carry the
    // rest. Editing this share alone would make the group's shares stop adding
    // up to the matter's work, with nothing on any single invoice looking wrong.
    const { rowCount } = await testPool.query(
      'update invoices set split_group_id = $2, split_mode = $3, split_recipient_count = 2 where id = $1',
      [invoiceId, randomUUID(), 'even'],
    );
    expect(rowCount).toBe(1);

    const res = await patchLines({ flatFees: [{ description: 'Reduced fee', amount: 250 }] });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/split group/i);
    expect(Number((await row()).total_cents)).toBe(100_000);
  });

  it('refuses a member without the invoice-management permission', async () => {
    const reader = await memberWith(firm.id, ['billing.view', 'clients.view']);

    const res = await reader.api.patch(onInvoice('/line-items')).send({
      timeEntries: [], flatFees: [{ id: randomUUID(), description: 'Sneaky', amount: 1 }], expenses: [],
    });

    expect(res.status).toBe(403);
    // The refusal has to be measured against a world where the money exists,
    // or it passes whether the edit was blocked or simply had nothing to do.
    expect(Number((await row()).total_cents)).toBe(100_000);
    expect((await lines()).map((l: any) => l.description)).toEqual(['Original fee']);
  });

  it('does not let one firm rewrite another firm invoice', async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const intruder = await ownerOf(other.id);
    const theirClient = await createPersonClient(other.id, { name: 'Their Client' });

    // The intruder owns everything in its own firm and addresses the victim's
    // invoice through its own firm's path, which is the shape an id-walking
    // attempt actually takes.
    const res = await intruder.api
      .patch(`/api/lawfirms/${other.id}/billing/invoices/client/${theirClient.id}/${invoiceId}/line-items`)
      .send({ timeEntries: [], flatFees: [{ id: randomUUID(), description: 'Stolen', amount: 1 }], expenses: [] });

    expect(res.status).toBe(404);
    expect(Number((await row()).total_cents)).toBe(100_000);
    expect((await lines()).map((l: any) => l.description)).toEqual(['Original fee']);
  });
});
