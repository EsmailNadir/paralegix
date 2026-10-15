/**
 * Invoice adjustments: credit notes, added amounts, late fees and payment plans.
 *
 * `invoices.service.ts` is the largest file in the backend and the money lives in
 * it. `invoiceLifecycle.test.ts` covers create-pay-delete; this file covers the
 * ways an invoice's balance changes AFTER it is issued, which is where the
 * arithmetic gets interesting and where a defect is a wrong bill rather than a
 * cosmetic bug.
 *
 * Every case asserts the stored CENTS and the generated `balance_due_cents`
 * column, not just the response, because those two disagreeing is exactly the
 * class of bug worth catching.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const base = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

// Invoice names must be UNIQUE within a firm: the name becomes the invoice
// number, so reusing one makes the second create fail with no `invoice` in the
// body, and every assertion after it dies on `undefined.id` far from the cause.
let invoiceSeq = 0;

async function newInvoice(totalAmount = 1000, overrides: Record<string, unknown> = {}) {
  invoiceSeq += 1;
  const res = await owner.api.post(base()).send({
    invoiceName: `Invoice ${invoiceSeq} for ${totalAmount}`,
    invoiceDate: '2026-03-01',
    dueDate: '2026-03-31',
    totalAmount,
    flatFeesAmount: totalAmount,
    flatFees: [{ description: 'Fixed fee', amount: totalAmount }],
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.invoice.id as string;
}

async function row(invoiceId: string) {
  const { rows } = await testPool.query(
    `select total_cents, amount_paid_cents, balance_due_cents, total_written_off_cents, is_paid, status
       from invoices where id = $1`,
    [invoiceId],
  );
  return rows[0];
}

/**
 * Turn on the firm's default tax rate, exactly like `invoiceTax.test.ts`'s
 * helper. Needed here (not there) to prove a credit note's exceeds-balance
 * guard compares against the TAX-INCLUSIVE total, not the pre-tax subtotal.
 */
async function enableFirmTax(rate: number) {
  const { rowCount } = await testPool.query(
    `update law_firms
        set settings = coalesce(settings, '{}'::jsonb)
          || jsonb_build_object(
               'billing',
               coalesce(settings -> 'billing', '{}'::jsonb)
                 || jsonb_build_object(
                      'tax',
                      jsonb_build_object('enabled', true, 'defaultRate', $2::numeric, 'label', 'Sales Tax')
                    )
             )
      where id = $1`,
    [firm.id, rate],
  );
  expect(rowCount).toBe(1);
}

/**
 * Turn on the firm's late-fee policy.
 *
 * Late fees are OFF by default and live in `law_firms.settings.billing.lateFee`,
 * so `applyLateFee` refuses with "Late fees are not enabled for this firm" before
 * it ever looks at the invoice. A test that skipped this would be asserting
 * against that refusal rather than against the fee logic.
 */
async function enableLateFees(overrides: Record<string, unknown> = {}) {
  await testPool.query(
    `update law_firms
        set settings = coalesce(settings, '{}'::jsonb)
          || jsonb_build_object('billing',
               coalesce(settings -> 'billing', '{}'::jsonb)
                 || jsonb_build_object('lateFee', $2::jsonb))
      where id = $1`,
    [firm.id, JSON.stringify({ enabled: true, flatAmount: 25, percent: 0, graceDays: 5, ...overrides })],
  );
}

beforeEach(async () => {
  invoiceSeq = 0;
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Adjusted Client' });
  await drainEvents();
});

describe('credit notes', () => {
  it('reduces what is owed without recording money received', async () => {
    const id = await newInvoice(1000);

    const res = await owner.api.post(`${base()}/${id}/credit-note`)
      .send({ amount: 250, type: 'discount', description: 'Goodwill' });
    expect([200, 201]).toContain(res.status);
    await drainEvents();

    const stored = await row(id);
    // A credit is not a payment. If it moved `amount_paid_cents`, the firm's
    // received-cash figures would include money nobody sent.
    expect(Number(stored.amount_paid_cents)).toBe(0);
    expect(Number(stored.balance_due_cents)).toBe(75_000);
  });

  it('accepts each credit note type', async () => {
    for (const type of ['write_off', 'discount', 'adjustment']) {
      // eslint-disable-next-line no-await-in-loop
      const id = await newInvoice(500);
      // eslint-disable-next-line no-await-in-loop
      const res = await owner.api.post(`${base()}/${id}/credit-note`)
        .send({ amount: 100, type });
      expect(res.status).toBe(200);
      // Every type lowers what is owed by exactly the credit, as a write-off,
      // and none of them records money received.
      // eslint-disable-next-line no-await-in-loop
      const stored = await row(id);
      expect(Number(stored.balance_due_cents)).toBe(40_000);
      expect(Number(stored.total_written_off_cents)).toBe(10_000);
      expect(Number(stored.amount_paid_cents)).toBe(0);
    }
  });

  it('rejects an unknown credit note type', async () => {
    const id = await newInvoice();

    const res = await owner.api.post(`${base()}/${id}/credit-note`)
      .send({ amount: 100, type: 'freebie' });

    expect(res.status).toBe(400);
  });

  it('rejects a zero or negative credit', async () => {
    const id = await newInvoice();

    for (const amount of [0, -100]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await owner.api.post(`${base()}/${id}/credit-note`)
        .send({ amount, type: 'discount' });
      expect(res.status).toBe(400);
    }
  });

  it('marks the invoice settled when a credit clears the whole balance', async () => {
    const id = await newInvoice(1000);

    await owner.api.post(`${base()}/${id}/credit-note`)
      .send({ amount: 1000, type: 'write_off' });
    await drainEvents();

    const stored = await row(id);
    // Written off in full: nothing is owed and nothing was received.
    expect(Number(stored.balance_due_cents)).toBe(0);
    expect(Number(stored.amount_paid_cents)).toBe(0);
  });

  it('combines with a payment without double counting', async () => {
    const id = await newInvoice(1000);

    await owner.api.put(`${base()}/${id}/payment`)
      .send({ paymentAmount: 400, paidDate: '2026-03-10' });
    await owner.api.post(`${base()}/${id}/credit-note`)
      .send({ amount: 100, type: 'discount' });
    await drainEvents();

    const stored = await row(id);
    // 1000 owed, 400 paid, 100 credited leaves 500.
    expect(Number(stored.amount_paid_cents)).toBe(40_000);
    expect(Number(stored.balance_due_cents)).toBe(50_000);
  });

  it('refuses a member without the invoice permission', async () => {
    const id = await newInvoice();
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.post(`${base()}/${id}/credit-note`)
      .send({ amount: 100, type: 'discount' });

    expect(res.status).toBe(403);
  });

  it('settles a taxed invoice in full via a "discount" credit note against the TAX-INCLUSIVE total', async () => {
    // B06.2 M02: a 100% discount is only really 100% if it is measured against
    // what the client actually owes, tax included. 123456 x 8.875% = 10,956.72,
    // rounded to 10,957 -- the same distinctive figure `invoiceTax.test.ts`
    // uses, so a discount computed against the pre-tax subtotal instead of the
    // taxed total would settle the invoice 109.57 short.
    await enableFirmTax(8.875);
    const id = await newInvoice(1234.56);
    const before = await row(id);
    expect(Number(before.total_cents)).toBe(134_413); // 123,456 + 10,957 tax

    const res = await owner.api.post(`${base()}/${id}/credit-note`)
      .send({ amount: 1344.13, type: 'discount', description: 'Full courtesy discount' });
    expect(res.status).toBe(200);
    await drainEvents();

    const stored = await row(id);
    expect(Number(stored.total_written_off_cents)).toBe(134_413);
    expect(Number(stored.balance_due_cents)).toBe(0);
    expect(Number(stored.amount_paid_cents)).toBe(0);
    // Forgiven money was not collected, so the settled invoice reads credited.
    expect(stored.is_paid).toBe(false);
    expect(stored.status).toBe('credited');
  });

  it('rejects a single credit note larger than the invoice total, and writes nothing', async () => {
    const id = await newInvoice(1000);

    const res = await owner.api.post(`${base()}/${id}/credit-note`)
      .send({ amount: 1000.01, type: 'discount' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds the invoice remaining balance/i);

    // The rejection must not have left a half-applied state: no credit note
    // recorded, the balance untouched, and the invoice still open.
    const stored = await row(id);
    expect(Number(stored.total_written_off_cents)).toBe(0);
    expect(Number(stored.balance_due_cents)).toBe(100_000);
    expect(stored.is_paid).toBe(false);
  });

  it('rejects a credit note that, combined with an existing payment, would exceed the remaining balance', async () => {
    const id = await newInvoice(1000);

    // 300 already paid; only 700 remains. A 700.01 discount overshoots by a
    // single cent -- exact-cent comparison, not float-epsilon luck.
    await owner.api.put(`${base()}/${id}/payment`)
      .send({ paymentAmount: 300, paidDate: '2026-03-10' });
    await drainEvents();

    const res = await owner.api.post(`${base()}/${id}/credit-note`)
      .send({ amount: 700.01, type: 'write_off' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds the invoice remaining balance/i);

    // The existing 300 payment survives untouched and no credit note landed.
    const stored = await row(id);
    expect(Number(stored.amount_paid_cents)).toBe(30_000);
    expect(Number(stored.total_written_off_cents)).toBe(0);
    expect(Number(stored.balance_due_cents)).toBe(70_000);

    // Exactly at the boundary (700.00) is allowed and settles the invoice --
    // the control proving the rejection above is about the boundary, not
    // about write-offs being broken outright.
    const exact = await owner.api.post(`${base()}/${id}/credit-note`)
      .send({ amount: 700, type: 'write_off' });
    expect(exact.status).toBe(200);
    const settled = await row(id);
    expect(Number(settled.balance_due_cents)).toBe(0);
    // 300 was collected and 700 forgiven: settled by write-off, so credited.
    expect(settled.is_paid).toBe(false);
    expect(settled.status).toBe('credited');
  });

  it('rejects a second credit note that would push the combined write-off past the total, leaving the first credit note intact', async () => {
    const id = await newInvoice(1000);

    const first = await owner.api.post(`${base()}/${id}/credit-note`)
      .send({ amount: 600, type: 'discount' });
    expect(first.status).toBe(200);
    await drainEvents();

    // 600 already credited; 400 remains. A second credit of 400.01 overshoots.
    const second = await owner.api.post(`${base()}/${id}/credit-note`)
      .send({ amount: 400.01, type: 'adjustment' });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/exceeds the invoice remaining balance/i);

    // The first credit note is untouched by the second's rejection: same
    // total written off, same remaining balance, invoice still open.
    const stored = await row(id);
    expect(Number(stored.total_written_off_cents)).toBe(60_000);
    expect(Number(stored.balance_due_cents)).toBe(40_000);
    expect(stored.is_paid).toBe(false);

    // No single-invoice GET route exists for this context; the list route is
    // the read surface that shows what actually persisted.
    const list = await owner.api.get(base());
    const invoice = list.body.invoices.find((inv: any) => inv.id === id);
    expect(invoice.creditNotes).toHaveLength(1);
    expect(invoice.creditNotes[0].amount).toBe(600);
  });
});

// Adding an amount to an invoice is pinned in `invoiceMoneyOverflowSweep.test.ts`.

describe('late fees', () => {
  it('refuses outright when the firm has not enabled late fees', async () => {
    // The default. Charging a client a penalty the firm never configured would
    // be indefensible, so this is a hard refusal rather than a silent skip.
    const id = await newInvoice();

    const res = await owner.api.post(`${base()}/${id}/late-fee`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not enabled/i);
  });

  it('applies nothing while the invoice is inside its grace period', async () => {
    await enableLateFees({ graceDays: 5 });
    // A due date in the FUTURE. The fixture's default of 2026-03-31 is months
    // past by now, so an invoice created with it is already overdue and this
    // case would assert the opposite of what it claims.
    const future = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const id = await newInvoice(1000, { dueDate: future });

    const res = await owner.api.post(`${base()}/${id}/late-fee`);

    // A refusal with a reason, not a 200 carrying a skip. Both are defensible
    // designs; this is the one that ships, and the message is what the firm sees.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not yet past due/i);
    const stored = await row(id);
    expect(Number(stored.total_cents)).toBe(100_000);
  });

  it('returns the late fee as an adjustment row on the list the detail view reads', async () => {
    await enableLateFees({ flatAmount: 25, percent: 0, graceDays: 0 });
    const id = await newInvoice(1000);
    expect((await owner.api.post(`${base()}/${id}/late-fee`)).status).toBe(200);

    // The detail view and the client-invoice page both load through this list.
    // They render `amountAdjustmentNotes` as the Adjustments section and read it
    // to decide whether "Apply late fee" is still available; a serializer that
    // dropped it showed a total that grew for no visible reason and an action
    // that stayed enabled and then failed with "already applied".
    const list = await owner.api.get(base());
    const invoice = list.body.invoices.find((inv: any) => inv.id === id);
    expect(invoice.amountAdjustmentNotes).toEqual([
      expect.objectContaining({ kind: 'late_fee', amount: 25 }),
    ]);
  });

  it('applies the configured flat fee once the invoice is overdue', async () => {
    await enableLateFees({ flatAmount: 25, percent: 0, graceDays: 0 });
    const id = await newInvoice(1000);

    const res = await owner.api.post(`${base()}/${id}/late-fee`);

    expect(res.status).toBe(200);
    const stored = await row(id);
    // $25 on top of $1,000, in cents.
    expect(Number(stored.total_cents)).toBe(102_500);
    expect(Number(stored.balance_due_cents)).toBe(102_500);
  });

  it('does not stack a second fee on the same invoice', async () => {
    await enableLateFees({ flatAmount: 25, percent: 0, graceDays: 0 });
    const id = await newInvoice(1000);

    const first = await owner.api.post(`${base()}/${id}/late-fee`);
    expect(first.status).toBe(200);

    const second = await owner.api.post(`${base()}/${id}/late-fee`);

    // A late fee is a ONE-TIME charge, and the apply path is shared by this
    // manual route and an automatic cron pass, so the second attempt must not
    // charge again. It is refused rather than silently ignored.
    expect(second.status).toBe(400);
    const stored = await row(id);
    // 1000 plus ONE 25 fee, not two.
    expect(Number(stored.total_cents)).toBe(102_500);
  });

  it('refuses a member without the invoice permission', async () => {
    await enableLateFees();
    const id = await newInvoice();
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.post(`${base()}/${id}/late-fee`);

    // The permission gate runs before the enablement check, so this is 403 and
    // not the "not enabled" 400.
    expect(res.status).toBe(403);
  });
});

describe('payment plans', () => {
  async function setPlan(id: string, body: Record<string, unknown> = {}) {
    return owner.api.post(`${base()}/${id}/payment-plan`).send({
      installmentAmount: 250,
      frequencyDays: 30,
      planStartDate: '2026-04-01',
      ...body,
    });
  }

  // The generated schedule, its refusals, removing a plan and the permission
  // gate are pinned in `invoiceInstallments.test.ts`.

  it('rejects a plan with no start date', async () => {
    const id = await newInvoice();

    const res = await owner.api.post(`${base()}/${id}/payment-plan`)
      .send({ installmentAmount: 250, frequencyDays: 30 });

    expect(res.status).toBe(400);
  });

  it('accepts a down payment', async () => {
    const id = await newInvoice(1000);

    const res = await setPlan(id, { downPaymentAmount: 200, downPaymentAlreadyPaid: false });

    expect(res.status).toBe(200);
    const plan = res.body.invoice.paymentPlan;
    expect(plan.downPaymentAmount).toBe(200);
    // The down payment is the first instalment, due on the plan start date, and
    // the schedule still covers the invoice exactly: 200 plus 250s to 1000.
    expect(plan.expectedPayments[0]).toMatchObject({
      amount: 200, isDownPayment: true, dueDate: '2026-04-01',
    });
    expect(plan.expectedPayments.reduce((sum: number, p: any) => sum + p.amount, 0)).toBe(1000);
    // Not already paid, so nothing is recorded as received.
    expect(Number((await row(id)).amount_paid_cents)).toBe(0);
  });
});

describe('the unbilled summary', () => {
  it('counts an unbilled time entry', async () => {
    await testPool.query(
      `insert into activities (kind, law_firm_id, client_id, activity_date, hours, rate_cents, description)
       values ('time', $1, $2, current_date, 2, 30000, 'Unbilled work')`,
      [firm.id, client.id],
    );

    const res = await owner.api.get(`${base()}/unbilled-summary`);

    expect(res.status).toBe(200);
    // Two hours at 300.00. The summary is what a firm bills from, so a missing
    // entry here is revenue nobody invoices.
    expect(Number(res.body.totalUnbilledHours)).toBe(2);
  });

  it('does not count another firm unbilled work', async () => {
    const otherFirm = await createFirm();
    const otherClient = await createPersonClient(otherFirm.id);
    await testPool.query(
      `insert into activities (kind, law_firm_id, client_id, activity_date, hours, rate_cents)
       values ('time', $1, $2, current_date, 99, 50000)`,
      [otherFirm.id, otherClient.id],
    );

    const res = await owner.api.get(`${base()}/unbilled-summary`);

    expect(res.status).toBe(200);
    expect(Number(res.body.totalUnbilledHours)).toBe(0);
  });
});
