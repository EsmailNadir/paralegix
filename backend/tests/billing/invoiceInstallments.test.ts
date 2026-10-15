/**
 * Payment plans on an invoice, and the instalment schedule they generate.
 *
 * `invoiceAdjustments.test.ts` covers setting and removing a plan. This file
 * covers the schedule itself, which is where the money is: a client on a plan
 * pays what the instalments say, so a schedule that does not add up to the
 * invoice either over-collects or leaves a balance nobody is scheduled to pay.
 *
 * The field names are worth stating, because they are not the obvious ones:
 * `frequencyDays` and `planStartDate`, not `frequency`/`startDate`. Guessing
 * wrong gives a validation error naming fields the caller never sent.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let invoiceId: string;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
const onInvoice = (suffix: string) => `${B()}/${invoiceId}${suffix}`;

const setPlan = (body: Record<string, unknown> = {}) =>
  owner.api.post(onInvoice('/payment-plan')).send({
    installmentAmount: 300,
    frequencyDays: 30,
    planStartDate: '2026-04-01',
    ...body,
  });

const installments = async () => {
  const { rows } = await testPool.query(
    `select amount_cents, due_date, status from invoice_expected_payments
      where invoice_id = $1 order by due_date`, [invoiceId],
  );
  return rows;
};

const scheduledTotal = async () =>
  (await installments()).reduce((sum: number, r: any) => sum + Number(r.amount_cents), 0);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Plan Client' });

  // A single flat fee carries the amount: the service refuses an invoice whose
  // total does not equal the sum of its line items.
  const created = await owner.api.post(B()).send({
    invoiceName: 'Plan Invoice',
    invoiceDate: '2026-03-01',
    dueDate: '2026-04-01',
    totalAmount: 1200,
    flatFeesAmount: 1200,
    flatFees: [{ description: 'Fixed fee', amount: 1200 }],
  });
  invoiceId = created.body.invoice.id;
  await drainEvents();
});

describe('the generated schedule', () => {
  it('creates one pending instalment per payment, in cents, covering the total EXACTLY', async () => {
    const res = await setPlan({ installmentAmount: 300 });

    expect(res.status).toBe(200);
    const rows = await installments();
    // $1200 in $300 instalments is four payments.
    expect(rows).toHaveLength(4);
    expect(rows.map((r: any) => Number(r.amount_cents))).toEqual([30_000, 30_000, 30_000, 30_000]);
    // An instalment created already paid would credit the client money they
    // never sent.
    expect(rows.map((r: any) => r.status)).toEqual(['pending', 'pending', 'pending', 'pending']);
    // The property that matters. A schedule adding to less leaves a balance
    // nobody is scheduled to pay, and the invoice ages quietly; adding to more
    // over-collects from a client who is paying exactly what they were told to.
    expect(await scheduledTotal()).toBe(120_000);
  });

  it('spaces the instalments by the configured interval', async () => {
    await setPlan({ installmentAmount: 300, frequencyDays: 30, planStartDate: '2026-04-01' });

    const rows = await installments();
    expect(rows[0].due_date).toBe('2026-04-01');
    // Later than the first, and in order. A schedule that stacked every
    // instalment on one date is a lump sum wearing a plan's clothes.
    expect(rows[1].due_date > rows[0].due_date).toBe(true);
    expect(rows[3].due_date > rows[2].due_date).toBe(true);
  });

  it('handles an instalment that does not divide the total evenly', async () => {
    await setPlan({ installmentAmount: 500 });

    // $1200 in $500 instalments is 500, 500 and 200. The remainder has to land
    // somewhere, and it has to still add up.
    expect(await scheduledTotal()).toBe(120_000);
  });

  it('handles ONE instalment covering the whole invoice', async () => {
    await setPlan({ installmentAmount: 1200 });

    expect(await installments()).toHaveLength(1);
    expect(await scheduledTotal()).toBe(120_000);
  });

  it('CLAMPS an instalment larger than the invoice to the balance', async () => {
    const res = await setPlan({ installmentAmount: 5000 });

    // Accepted, not refused, and the schedule is clamped: one instalment for the
    // $1200 actually owed rather than the $5000 asked for. That is the right
    // answer, since the client is only ever asked for what they owe.
    //
    // Recorded because the stored `plan_installment_cents` keeps the requested
    // 500000 while the schedule holds 120000, so the plan's own summary and its
    // instalments disagree on screen. Cosmetic, and reported rather than
    // changed: the money is right.
    expect(res.status).toBe(200);
    expect(await installments()).toHaveLength(1);
    expect(await scheduledTotal()).toBe(120_000);
  });

  it('refuses a zero or negative instalment', async () => {
    expect((await setPlan({ installmentAmount: 0 })).status).toBe(400);
    expect((await setPlan({ installmentAmount: -50 })).status).toBe(400);
  });

  it('refuses a zero or negative frequency', async () => {
    expect((await setPlan({ frequencyDays: 0 })).status).toBe(400);
    expect((await setPlan({ frequencyDays: -30 })).status).toBe(400);
  });
});

describe('changing one instalment', () => {
  beforeEach(async () => {
    await setPlan({ installmentAmount: 300 });
  });

  it('updates its amount', async () => {
    const res = await owner.api.patch(onInvoice('/payment-plan/installment/0'))
      .send({ amount: 400 });

    expect(res.status).toBe(200);
    expect(Number((await installments())[0].amount_cents)).toBe(40_000);
  });

  it('refuses an index that does not exist', async () => {
    const res = await owner.api.patch(onInvoice('/payment-plan/installment/99'))
      .send({ amount: 400 });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a zero or negative amount', async () => {
    const res = await owner.api.patch(onInvoice('/payment-plan/installment/0'))
      .send({ amount: 0 });

    // A zero instalment is a deletion wearing an edit's clothes, and it leaves a
    // schedule row claiming a payment of nothing is due.
    expect(res.status).toBe(400);
  });

  it('refuses when there is no plan at all', async () => {
    await owner.api.delete(onInvoice('/payment-plan'));

    const res = await owner.api.patch(onInvoice('/payment-plan/installment/0'))
      .send({ amount: 400 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no active payment plan/i);
  });

  // An edit to one instalment moves the schedule total off the invoice total,
  // and nothing else recomputes it. The plan then quietly collects the wrong
  // amount: a raised instalment over-collects, a lowered one leaves a balance
  // no instalment is scheduled to pay and the invoice never settles.
  it('keeps the schedule covering the invoice when one instalment goes UP', async () => {
    await owner.api.patch(onInvoice('/payment-plan/installment/0')).send({ amount: 400 });

    expect(await scheduledTotal()).toBe(120_000);
  });

  it('keeps the schedule covering the invoice when one instalment goes DOWN', async () => {
    await owner.api.patch(onInvoice('/payment-plan/installment/0')).send({ amount: 100 });

    expect(await scheduledTotal()).toBe(120_000);
  });

  it('absorbs the difference AFTER the edited instalment, not into it', async () => {
    await owner.api.patch(onInvoice('/payment-plan/installment/0')).send({ amount: 400 });

    const rows = await installments();
    // The firm typed 400 and 400 is what stands. Rebuilding the whole schedule
    // from the plan's own instalment amount would erase the edit it was asked
    // to make.
    expect(Number(rows[0].amount_cents)).toBe(40_000);
    expect(Number(rows[3].amount_cents)).toBe(20_000);
  });

  it('extends the schedule when the LAST instalment is lowered', async () => {
    await owner.api.patch(onInvoice('/payment-plan/installment/3')).send({ amount: 100 });

    const rows = await installments();
    // Nothing after the last instalment can take the shortfall, so the plan
    // gains a further instalment rather than losing $200 of the invoice.
    expect(rows).toHaveLength(5);
    expect(await scheduledTotal()).toBe(120_000);
  });

  it('protects the MERGED instalment when a reschedule combines two of them', async () => {
    // Raise instalment 0 to $900 and move it onto instalment 2's date, so the
    // two combine into one $1200 row. The schedule then adds to $1800 against a
    // $1200 invoice, and the excess cannot be absorbed by the $300 left after
    // it. The honest answer is to refuse.
    const res = await owner.api.patch(onInvoice('/payment-plan/installment/0'))
      .send({ amount: 900, dueDate: '2026-06-01' });

    // The trap: the reconciliation has to know the edit now lives on the row it
    // merged INTO. Aimed one row off, it shaves the merged instalment back to
    // $900 and reports success, silently dropping $300 of what was asked for.
    expect(res.status).toBe(400);
    expect(await scheduledTotal()).toBe(120_000);
    expect(await installments()).toHaveLength(4);
  });

  it('refuses an instalment larger than the balance the plan still owes', async () => {
    const res = await owner.api.patch(onInvoice('/payment-plan/installment/0'))
      .send({ amount: 1500 });

    // $1500 on a $1200 invoice cannot be absorbed by shrinking what follows.
    // Accepting it would schedule the client for more than they owe.
    expect(res.status).toBe(400);
    expect(await scheduledTotal()).toBe(120_000);
  });
});

describe('replacing the whole schedule', () => {
  beforeEach(async () => {
    await setPlan({ installmentAmount: 300 });
  });

  it('replaces the instalments with the ones given', async () => {
    const res = await owner.api.patch(onInvoice('/payment-plan/schedule')).send({
      installments: [
        { amount: 600, dueDate: '2026-05-01' },
        { amount: 600, dueDate: '2026-06-01' },
      ],
    });

    expect(res.status).toBe(200);
    const rows = await installments();
    // REPLACE, not append. Appending would double the schedule and ask the
    // client for twice the invoice.
    expect(rows).toHaveLength(2);
    expect(Number(rows[0].amount_cents)).toBe(60_000);
  });

  it('still covers the invoice total exactly', async () => {
    await owner.api.patch(onInvoice('/payment-plan/schedule')).send({
      installments: [
        { amount: 600, dueDate: '2026-05-01' },
        { amount: 600, dueDate: '2026-06-01' },
      ],
    });

    expect(await scheduledTotal()).toBe(120_000);
  });

  it('refuses a schedule that does not add up to the invoice', async () => {
    const res = await owner.api.patch(onInvoice('/payment-plan/schedule')).send({
      installments: [
        { amount: 600, dueDate: '2026-05-01' },
        { amount: 900, dueDate: '2026-06-01' },
      ],
    });

    // $1500 of instalments against a $1200 invoice. Unlike a single-instalment
    // edit there is nothing to absorb it into: the caller stated the whole
    // schedule, so the only honest answer is to refuse it.
    expect(res.status).toBe(400);
    expect(await scheduledTotal()).toBe(120_000);
  });

  it('refuses a schedule that leaves part of the invoice unscheduled', async () => {
    const res = await owner.api.patch(onInvoice('/payment-plan/schedule')).send({
      installments: [
        { amount: 400, dueDate: '2026-05-01' },
        { amount: 400, dueDate: '2026-06-01' },
      ],
    });

    expect(res.status).toBe(400);
    expect(await scheduledTotal()).toBe(120_000);
  });

  it('refuses an empty schedule', async () => {
    const res = await owner.api.patch(onInvoice('/payment-plan/schedule'))
      .send({ installments: [] });

    // A plan with no instalments is a balance nobody will ever be asked for.
    expect(res.status).toBe(400);
  });

  it('leaves the old schedule standing when it refuses', async () => {
    await owner.api.patch(onInvoice('/payment-plan/schedule')).send({ installments: [] });

    // Asserting the DATA. A route that cleared the old schedule before
    // validating the new one would leave the invoice with no plan at all.
    expect(await installments()).toHaveLength(4);
  });
});

describe('payment-plan dates resist an offset-driven day shift', () => {
  const invoiceRow = async () => {
    const { rows } = await testPool.query(
      `select due_date, next_payment_date, plan_start_date from invoices where id = $1`,
      [invoiceId],
    );
    return rows[0];
  };

  it('keeps the literal planStartDate when it carries a time and a negative UTC offset', async () => {
    // 11:30pm Pacific on April 1st is 7:30am UTC on April 2nd. Resolving this
    // to a UTC instant first and reading the calendar day back off it would
    // store April 2nd; every part of the string names April 1st.
    const res = await setPlan({
      installmentAmount: 1200,
      planStartDate: '2026-04-01T23:30:00-08:00',
    });

    expect(res.status).toBe(200);
    const row = await invoiceRow();
    expect(row.plan_start_date).toBe('2026-04-01');
    expect(row.due_date).toBe('2026-04-01');
    expect(row.next_payment_date).toBe('2026-04-01');
    expect((await installments())[0].due_date).toBe('2026-04-01');
  });

  it('refuses an impossible planStartDate instead of rolling it over', async () => {
    const res = await setPlan({ planStartDate: '2026-02-30' });
    expect(res.status).toBe(400);
  });

  it('refuses an impossible downPaymentDueDate', async () => {
    const res = await setPlan({
      installmentAmount: 300,
      downPaymentAmount: 100,
      downPaymentDueDate: '2026-02-30',
    });
    expect(res.status).toBe(400);
  });

  it('refuses an impossible dueDate when replacing the schedule', async () => {
    await setPlan({ installmentAmount: 300 });

    const res = await owner.api.patch(onInvoice('/payment-plan/schedule')).send({
      installments: [{ amount: 1200, dueDate: '2026-02-30' }],
    });

    expect(res.status).toBe(400);
  });

  it('refuses an impossible dueDate when updating one instalment', async () => {
    await setPlan({ installmentAmount: 300 });

    const res = await owner.api.patch(onInvoice('/payment-plan/installment/0'))
      .send({ dueDate: '2026-02-30' });

    expect(res.status).toBe(400);
  });
});

describe('removing the plan', () => {
  it('clears the instalments', async () => {
    await setPlan({ installmentAmount: 300 });

    const res = await owner.api.delete(onInvoice('/payment-plan'));

    expect(res.status).toBe(200);
    expect(await installments()).toHaveLength(0);
  });

  it('leaves the invoice balance alone', async () => {
    await setPlan({ installmentAmount: 300 });
    await owner.api.delete(onInvoice('/payment-plan'));

    const { rows } = await testPool.query(
      'select balance_due_cents from invoices where id = $1', [invoiceId],
    );
    // A plan is a schedule for paying a debt, not the debt itself. Removing it
    // must not forgive the money.
    expect(Number(rows[0].balance_due_cents)).toBe(120_000);
  });
});

describe('tenancy and permissions', () => {
  it('does not let one firm set a plan on another firm invoice', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/billing/invoices/client/${client.id}/${invoiceId}/payment-plan`)
      .send({ installmentAmount: 300, frequencyDays: 30, planStartDate: '2026-04-01' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await installments()).toHaveLength(0);
  });

  it('refuses a member without the invoice permission', async () => {
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.post(onInvoice('/payment-plan'))
      .send({ installmentAmount: 300, frequencyDays: 30, planStartDate: '2026-04-01' });

    expect(res.status).toBe(403);
    expect(await installments()).toHaveLength(0);
  });
});
