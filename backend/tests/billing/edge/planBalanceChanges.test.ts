/**
 * What a plan's schedule does when the balance moves underneath it.
 *
 * A credit note, an added amount, a line item or tax edit and a late fee each
 * change what the invoice owes after the plan was cut. Every operation here
 * ends by asserting the invariant the whole module rests on: the instalments
 * still owed add up to the balance in whole cents.
 *
 * Fixtures: a $1,000 invoice on four $250 instalments due on the first of
 * April, May, June and July 2026.
 */
import { testPool } from '../../support/setupInProcess';
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);

const credit = (amount: number, type = 'write_off') =>
  k.owner.api.post(k.on('/credit-note')).send({ amount, type });

async function creditNoteIds() {
  const { rows } = await testPool.query(
    `select external_id from invoice_adjustments where invoice_id = $1 and direction = 'credit' order by sort_order`,
    [k.invoiceId],
  );
  return rows.map((r: any) => r.external_id as string);
}

const lineItems = (body: Record<string, unknown>) =>
  k.owner.api.patch(k.on('/line-items')).send({ timeEntries: [], expenses: [], flatFees: [], ...body });

beforeEach(async () => {
  expect((await k.setPlan()).status).toBe(200);
});

describe('a credit note after the plan was set', () => {
  it.each(['write_off', 'discount', 'adjustment'])('shrinks the last instalment for a %s and keeps every date', async (type) => {
    const res = await credit(100, type);
    expect(res.status).toBe(200);

    expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [15_000, 'pending']]);
    expect((await k.rows()).map((r) => r.due_date)).toEqual(['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01']);
    await k.expectScheduleMatchesBalance(undefined, type);
  });

  it('drops the trailing instalments a larger credit covers and moves the invoice due date back', async () => {
    const res = await credit(500);
    expect(res.status).toBe(200);

    expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending']]);
    const inv = await k.invoice();
    expect(inv.due_date).toBe('2026-05-01');
    expect(inv.next_payment_date).toBe('2026-04-01');
    await k.expectScheduleMatchesBalance(undefined, 'credit 500');
  });

  it('leaves a paid instalment alone and refits only the open ones', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });

    const res = await credit(300);
    expect(res.status).toBe(200);

    const rows = await k.rows();
    expect(rows.map((r) => [Number(r.amount_cents), r.status])).toEqual([
      [25_000, 'paid'], [25_000, 'pending'], [20_000, 'pending'],
    ]);
    expect(rows[0].matched_payment_index).toBe(0);
    expect(Number((await k.invoice()).balance_due_cents)).toBe(45_000);
    await k.expectScheduleMatchesBalance(undefined, 'credit after paid');
  });

  it('refuses a credit larger than the balance and leaves the schedule untouched', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });
    const before = await k.rows();

    const res = await credit(750.01);

    expect(res.status).toBe(400);
    expect(await k.rows()).toEqual(before);
    expect(Number((await k.invoice()).total_written_off_cents)).toBe(0);
  });

  it('puts the schedule back when the credit note is deleted', async () => {
    expect((await credit(100)).status).toBe(200);
    const [noteId] = await creditNoteIds();

    const res = await k.owner.api.delete(k.on(`/credit-note?creditNoteId=${noteId}`));
    expect(res.status).toBe(200);

    expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
    expect((await k.rows()).map((r) => r.due_date)).toEqual(['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01']);
    await k.expectScheduleMatchesBalance(undefined, 'credit deleted');
  });

  it('regrows trailing instalments on the plan cadence when a large credit is deleted', async () => {
    expect((await credit(500)).status).toBe(200);
    expect(await k.rows()).toHaveLength(2);
    const [noteId] = await creditNoteIds();

    const res = await k.owner.api.delete(k.on(`/credit-note?creditNoteId=${noteId}`));
    expect(res.status).toBe(200);

    expect((await k.rows()).map((r) => r.due_date)).toEqual(['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01']);
    await k.expectScheduleMatchesBalance(undefined, 'big credit deleted');
  });

  it('closes the open instalments when the credit covers everything still owed', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });

    const res = await credit(750);
    expect(res.status).toBe(200);

    // A full write-off settles the invoice and leaves nothing to collect: the
    // open rows go, and the instalment that was paid stays on the plan.
    const inv = await k.invoice();
    expect(Number(inv.balance_due_cents)).toBe(0);
    expect(inv.is_paid).toBe(false);
    expect(inv.payment_plan_enabled).toBe(true);
    expect(await k.shape()).toEqual([[25_000, 'paid']]);
    expect(inv.next_payment_date).toBeNull();
  });
});

describe('an amount added after the plan was set', () => {
  it('appends one instalment for exactly that amount a month after the last open one', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });

    const res = await k.owner.api.patch(k.on('/add-amount')).send({ amount: 99.99, note: 'Courier' });
    expect(res.status).toBe(200);

    const rows = await k.rows();
    expect(rows.map((r) => [r.due_date, Number(r.amount_cents), r.status])).toEqual([
      ['2026-04-01', 25_000, 'paid'], ['2026-05-01', 25_000, 'pending'], ['2026-06-01', 25_000, 'pending'],
      ['2026-07-01', 25_000, 'pending'], ['2026-08-01', 9_999, 'pending'],
    ]);
    expect((await k.invoice()).due_date).toBe('2026-08-01');
    await k.expectScheduleMatchesBalance(undefined, 'add amount');
  });

  it('is undone when the payment is later deleted and the schedule refits the new balance', async () => {
    await k.pay({ paymentAmount: 100, paidDate: '2026-04-01' });
    await k.owner.api.patch(k.on('/add-amount')).send({ amount: 100 });

    const res = await k.owner.api.delete(k.on('/payment?paymentIndex=0'));
    expect(res.status).toBe(200);

    expect(Number((await k.invoice()).balance_due_cents)).toBe(110_000);
    await k.expectScheduleMatchesBalance(undefined, 'add then delete payment');
  });
});

describe('line items and tax edited after the plan was set', () => {
  it('adds a tax-sized instalment when a tax rate is applied to the bill', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });

    const res = await lineItems({ flatFees: [{ description: 'Fixed fee', amount: 1000 }], taxRate: 10 });
    expect(res.status).toBe(200);

    const inv = await k.invoice();
    expect(Number(inv.total_cents)).toBe(110_000);
    expect(await k.shape()).toEqual([
      [25_000, 'paid'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [10_000, 'pending'],
    ]);
    await k.expectScheduleMatchesBalance(undefined, 'tax on');
  });

  it('shrinks the open instalments when a line is cut and keeps the paid one', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });

    const res = await lineItems({ flatFees: [{ description: 'Fixed fee', amount: 600 }] });
    expect(res.status).toBe(200);

    expect(await k.shape()).toEqual([[25_000, 'paid'], [25_000, 'pending'], [10_000, 'pending']]);
    expect((await k.invoice()).due_date).toBe('2026-06-01');
    await k.expectScheduleMatchesBalance(undefined, 'lines cut');
  });

  it('refuses a total below what was paid until it is acknowledged, leaving the schedule alone', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });
    const before = await k.rows();

    const refused = await lineItems({ flatFees: [{ description: 'Fixed fee', amount: 100 }] });

    expect(refused.status).toBe(409);
    expect(await k.rows()).toEqual(before);

    const accepted = await lineItems({ flatFees: [{ description: 'Fixed fee', amount: 100 }], acknowledgeOverpayment: true });
    expect(accepted.status).toBe(200);
    // Nothing is owed once the total is under what was paid, so no instalment is open.
    expect((await k.rows()).filter((r) => r.status !== 'paid')).toEqual([]);
    expect((await k.invoice()).next_payment_date).toBeNull();
    expect((await k.invoice()).is_paid).toBe(true);
  });

  it('refits the open instalments to rounded tax cents', async () => {
    const res = await lineItems({ flatFees: [{ description: 'Fixed fee', amount: 333.33 }], taxRate: 7.25 });
    expect(res.status).toBe(200);

    // 33,333 cents at 7.25% is 2,416.64 rounded to 2,417: a total of 35,750.
    expect(Number((await k.invoice()).total_cents)).toBe(35_750);
    expect(await k.shape()).toEqual([[25_000, 'pending'], [10_750, 'pending']]);
    await k.expectScheduleMatchesBalance(undefined, 'tax rounding');
  });
});

describe('a late fee on an invoice with a plan', () => {
  async function enableLateFees() {
    await testPool.query(
      `update law_firms
          set settings = coalesce(settings, '{}'::jsonb)
            || jsonb_build_object('billing', jsonb_build_object('lateFee',
                 '{"enabled": true, "flatAmount": 25, "percent": 0, "graceDays": 0}'::jsonb))
        where id = $1`,
      [k.firm.id],
    );
  }

  it('is charged once and raises the total by exactly the fee', async () => {
    await enableLateFees();

    const first = await k.owner.api.post(k.on('/late-fee')).send({});
    const second = await k.owner.api.post(k.on('/late-fee')).send({});

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    expect(Number((await k.invoice()).total_cents)).toBe(102_500);
  });
});

describe('removing the plan', () => {
  it('keeps the balance, the payments and the due date, and clears the schedule and next payment date', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });

    const res = await k.owner.api.delete(k.on('/payment-plan'));
    expect(res.status).toBe(200);

    const inv = await k.invoice();
    expect(await k.rows()).toHaveLength(0);
    expect(inv.payment_plan_enabled).toBe(false);
    expect(Number(inv.balance_due_cents)).toBe(75_000);
    expect(Number(inv.amount_paid_cents)).toBe(25_000);
    expect(inv.next_payment_date).toBeNull();
    expect(inv.due_date).toBe('2026-07-01');
    expect(await k.payments()).toHaveLength(1);
    // Part-paid wins over past-due in the derived status.
    expect(inv.status).toBe('partially_paid');
  });

  it('lets a fresh plan be set for exactly what is still owed afterwards', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });
    await k.owner.api.delete(k.on('/payment-plan'));

    const res = await k.setPlan({ installmentAmount: 300, planStartDate: '2026-09-01' });

    expect(res.status).toBe(200);
    expect(await k.shape()).toEqual([[30_000, 'pending'], [30_000, 'pending'], [15_000, 'pending']]);
    await k.expectScheduleMatchesBalance(undefined, 'plan again');
  });

  it('leaves a paid invoice paid when the plan is removed', async () => {
    await k.pay({ paymentAmount: 1000, paidDate: '2026-04-01' });

    const res = await k.owner.api.delete(k.on('/payment-plan'));

    expect(res.status).toBe(200);
    const inv = await k.invoice();
    expect(inv.is_paid).toBe(true);
    expect(inv.status).toBe('paid');
    expect(Number(inv.balance_due_cents)).toBe(0);
  });
});

describe('a refit on a plan that is already deep into the 120-row limit', () => {
  it('counts the paid instalments against the limit and puts the overflow on the last open instalment', async () => {
    const id = await k.createInvoice(1200);
    expect((await k.setPlan({ installmentAmount: 10 }, id)).status).toBe(200);
    expect((await k.pay({ paymentAmount: 500, paidDate: '2026-04-01' }, id)).status).toBe(200);
    expect((await k.rows(id)).filter((r) => r.status === 'paid')).toHaveLength(50);

    // Raising the bill by $1,800 needs 250 more $10 rows; only 70 open slots remain.
    const res = await k.owner.api.patch(k.on('/line-items', id)).send({
      timeEntries: [], expenses: [], flatFees: [{ description: 'Fixed fee', amount: 3000 }],
    });
    expect(res.status).toBe(200);

    const rows = await k.rows(id);
    expect(rows).toHaveLength(120);
    expect(rows.filter((r) => r.status === 'paid')).toHaveLength(50);
    const open = rows.filter((r) => r.status !== 'paid').map((r) => Number(r.amount_cents));
    expect(open.slice(0, -1).every((c) => c === 1_000)).toBe(true);
    expect(open[open.length - 1]).toBe(250_000 - 69 * 1_000);
    await k.expectScheduleMatchesBalance(id, 'refit at the cap');
  });
});
