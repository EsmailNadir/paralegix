/**
 * Editing a plan's schedule by hand: moving one instalment, merging two that
 * land on the same day, replacing the whole open schedule, and reversing a paid
 * instalment.
 *
 * Fixtures: a $1,000 invoice on four $250 instalments due on the first of
 * April, May, June and July 2026. Every case ends by asserting the open
 * instalments still add up to the balance.
 */
import { testPool } from '../../support/setupInProcess';
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);

const edit = (index: number, body: Record<string, unknown>) =>
  k.owner.api.patch(k.on(`/payment-plan/installment/${index}`)).send(body);
const replace = (installments: Array<{ dueDate: string; amount: number }>, extra: Record<string, unknown> = {}) =>
  k.owner.api.patch(k.on('/payment-plan/schedule')).send({ installments, ...extra });
const unpay = (index: number) => k.owner.api.delete(k.on(`/payment-plan/installment/${index}/payment`));

beforeEach(async () => {
  expect((await k.setPlan()).status).toBe(200);
});

describe('moving one instalment to another day', () => {
  it('changes only that date and leaves every amount alone', async () => {
    const res = await edit(1, { dueDate: '2026-05-20' });
    expect(res.status).toBe(200);

    expect((await k.rows()).map((r) => [r.due_date, Number(r.amount_cents)])).toEqual([
      ['2026-04-01', 25_000], ['2026-05-20', 25_000], ['2026-06-01', 25_000], ['2026-07-01', 25_000],
    ]);
    await k.expectScheduleMatchesBalance(undefined, 'move date');
  });

  it('merges into an open instalment already on that day, summing the amounts', async () => {
    const res = await edit(0, { dueDate: '2026-05-01' });
    expect(res.status).toBe(200);

    expect((await k.rows()).map((r) => [r.due_date, Number(r.amount_cents)])).toEqual([
      ['2026-05-01', 50_000], ['2026-06-01', 25_000], ['2026-07-01', 25_000],
    ]);
    expect((await k.invoice()).next_payment_date).toBe('2026-05-01');
    await k.expectScheduleMatchesBalance(undefined, 'merge');
  });

  it('merges a later instalment backwards onto an earlier day', async () => {
    const res = await edit(3, { dueDate: '2026-04-01' });
    expect(res.status).toBe(200);

    expect((await k.rows()).map((r) => [r.due_date, Number(r.amount_cents)])).toEqual([
      ['2026-04-01', 50_000], ['2026-05-01', 25_000], ['2026-06-01', 25_000],
    ]);
    expect((await k.invoice()).due_date).toBe('2026-06-01');
    await k.expectScheduleMatchesBalance(undefined, 'merge backwards');
  });

  it('does not merge into an instalment that is already paid', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });

    const res = await edit(1, { dueDate: '2026-04-01' });
    expect(res.status).toBe(200);

    const rows = await k.rows();
    expect(rows.map((r) => [r.due_date, Number(r.amount_cents), r.status])).toEqual([
      ['2026-04-01', 25_000, 'paid'], ['2026-04-01', 25_000, 'pending'],
      ['2026-06-01', 25_000, 'pending'], ['2026-07-01', 25_000, 'pending'],
    ]);
    expect(rows[0].matched_payment_index).toBe(0);
    await k.expectScheduleMatchesBalance(undefined, 'no merge into paid');
  });

  it('refuses to move a paid instalment and changes nothing', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });
    const before = await k.rows();

    const res = await edit(0, { dueDate: '2026-04-20' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/paid installment/i);
    expect(await k.rows()).toEqual(before);
  });

  it('keeps the instalment the firm typed and shaves the ones after it, dropping those shaved to nothing', async () => {
    const res = await edit(0, { amount: 750 });
    expect(res.status).toBe(200);

    expect((await k.rows()).map((r) => [r.due_date, Number(r.amount_cents)])).toEqual([
      ['2026-04-01', 75_000], ['2026-05-01', 25_000],
    ]);
    expect((await k.invoice()).due_date).toBe('2026-05-01');
    await k.expectScheduleMatchesBalance(undefined, 'raise to 750');
  });

  it('absorbs an amount edit on a middle instalment after it, not before it', async () => {
    const res = await edit(1, { amount: 100 });
    expect(res.status).toBe(200);

    expect((await k.rows()).map((r) => Number(r.amount_cents))).toEqual([25_000, 10_000, 25_000, 40_000]);
    await k.expectScheduleMatchesBalance(undefined, 'lower middle');
  });

  it('applies a date and an amount in one edit', async () => {
    const res = await edit(1, { amount: 150, dueDate: '2026-05-10' });
    expect(res.status).toBe(200);

    expect((await k.rows()).map((r) => [r.due_date, Number(r.amount_cents)])).toEqual([
      ['2026-04-01', 25_000], ['2026-05-10', 15_000], ['2026-06-01', 25_000], ['2026-07-01', 35_000],
    ]);
    await k.expectScheduleMatchesBalance(undefined, 'date and amount');
  });

  it('keeps the schedule covering what is owed after a payment when the last open instalment is lowered', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });

    const res = await edit(3, { amount: 100 });
    expect(res.status).toBe(200);

    expect((await k.rows()).map((r) => [Number(r.amount_cents), r.status])).toEqual([
      [25_000, 'paid'], [25_000, 'pending'], [25_000, 'pending'], [10_000, 'pending'], [15_000, 'pending'],
    ]);
    await k.expectScheduleMatchesBalance(undefined, 'lower last after payment');
  });
});

describe('replacing the open schedule', () => {
  it('keeps a paid instalment in place with its payment link and replaces the rest', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });

    const res = await replace([{ dueDate: '2026-06-01', amount: 375 }, { dueDate: '2026-08-01', amount: 375 }]);
    expect(res.status).toBe(200);

    const rows = await k.rows();
    expect(rows.map((r) => [r.due_date, Number(r.amount_cents), r.status])).toEqual([
      ['2026-04-01', 25_000, 'paid'], ['2026-06-01', 37_500, 'pending'], ['2026-08-01', 37_500, 'pending'],
    ]);
    expect(rows[0].matched_payment_index).toBe(0);
    expect((await k.invoice()).due_date).toBe('2026-08-01');
    await k.expectScheduleMatchesBalance(undefined, 'replace after payment');
  });

  it('replaces an open instalment that still carries a legacy hosted Stripe invoice like any other', async () => {
    // Only paid rows are kept by a replacement. A row stamped with a hosted invoice
    // from the retired per-instalment path is unpaid money, so the new schedule
    // must cover it; keeping it would leave $250 the firm meant to reschedule.
    await testPool.query(
      `update invoice_expected_payments set stripe_invoice_id = 'in_legacy', stripe_payment_status = 'pending'
        where invoice_id = $1 and sort_order = 1`, [k.invoiceId]);

    const res = await replace([{ dueDate: '2026-06-01', amount: 500 }, { dueDate: '2026-08-01', amount: 500 }]);
    expect(res.status).toBe(200);

    expect((await k.rows()).map((r) => [r.due_date, Number(r.amount_cents), r.status, r.stripe_invoice_id])).toEqual([
      ['2026-06-01', 50_000, 'pending', null], ['2026-08-01', 50_000, 'pending', null],
    ]);
    await k.expectScheduleMatchesBalance(undefined, 'replace over a legacy hosted row');
  });

  it('sorts a replacement that is dated before the paid instalment ahead of it', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 1, paidDate: '2026-05-01' });

    const res = await replace([
      { dueDate: '2026-04-15', amount: 400 }, { dueDate: '2026-09-01', amount: 350 },
    ]);
    expect(res.status).toBe(200);

    expect((await k.rows()).map((r) => [r.due_date, r.status])).toEqual([
      ['2026-04-15', 'pending'], ['2026-05-01', 'paid'], ['2026-09-01', 'pending'],
    ]);
    expect((await k.invoice()).next_payment_date).toBe('2026-04-15');
    await k.expectScheduleMatchesBalance(undefined, 'replace sorted');
  });

  it('refuses a schedule short of what is owed after a payment and leaves the old rows', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });
    const before = await k.rows();

    const res = await replace([{ dueDate: '2026-06-01', amount: 300 }, { dueDate: '2026-08-01', amount: 300 }]);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/\$600\.00.*\$750\.00/);
    expect(await k.rows()).toEqual(before);
  });

  it('refuses a schedule one cent over what is owed', async () => {
    const res = await replace([{ dueDate: '2026-06-01', amount: 500 }, { dueDate: '2026-08-01', amount: 500.01 }]);

    expect(res.status).toBe(400);
    await k.expectScheduleMatchesBalance(undefined, 'one cent over');
  });

  it('accepts cent-level amounts that add up exactly', async () => {
    const res = await replace([
      { dueDate: '2026-06-01', amount: 333.33 }, { dueDate: '2026-07-01', amount: 333.33 }, { dueDate: '2026-08-01', amount: 333.34 },
    ]);

    expect(res.status).toBe(200);
    expect((await k.rows()).map((r) => Number(r.amount_cents))).toEqual([33_333, 33_333, 33_334]);
  });

  it('switches the cadence that later additions follow', async () => {
    const res = await replace([{ dueDate: '2026-06-01', amount: 1000 }], { frequencyDays: 14 });
    expect(res.status).toBe(200);

    await k.owner.api.patch(k.on('/add-amount')).send({ amount: 50 });

    expect((await k.rows()).map((r) => r.due_date)).toEqual(['2026-06-01', '2026-06-15']);
    await k.expectScheduleMatchesBalance(undefined, 'cadence switched');
  });

  it('counts paid instalments toward the 120-row limit', async () => {
    const id = await k.createInvoice(1200);
    expect((await k.setPlan({ installmentAmount: 10 }, id)).status).toBe(200);
    // 1,000 paid unnamed settles the first 100 instalments; 20 stay open.
    expect((await k.pay({ paymentAmount: 1000, paidDate: '2026-04-01' }, id)).status).toBe(200);
    expect((await k.rows(id)).filter((r) => r.status === 'paid')).toHaveLength(100);
    const open = (n: number) => Array.from({ length: n }, (_, i) => ({
      dueDate: `2027-01-${String(1 + (i % 28)).padStart(2, '0')}`, amount: 200 / n,
    }));

    const tooMany = await k.owner.api.patch(k.on('/payment-plan/schedule', id)).send({
      installments: Array.from({ length: 21 }, (_, i) => ({ dueDate: `2027-01-${String(1 + i).padStart(2, '0')}`, amount: i === 20 ? 9.99 + 0.01 : 9.52 })),
    });
    const fits = await k.owner.api.patch(k.on('/payment-plan/schedule', id)).send({ installments: open(20) });

    expect(tooMany.status).toBe(400);
    expect(fits.status).toBe(200);
    expect(await k.rows(id)).toHaveLength(120);
    await k.expectScheduleMatchesBalance(id, 'at the cap');
  });
});

describe('reversing a paid instalment', () => {
  it('reopens the instalment and removes only its payment', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });
    await k.pay({ paymentAmount: 250, installmentIndex: 1, paidDate: '2026-05-01' });

    const res = await unpay(1);
    expect(res.status).toBe(200);

    expect((await k.rows()).map((r) => r.status)).toEqual(['paid', 'pending', 'pending', 'pending']);
    expect(await k.payments()).toHaveLength(1);
    expect(Number((await k.invoice()).balance_due_cents)).toBe(75_000);
    await k.expectScheduleMatchesBalance(undefined, 'unpay one');
  });

  it('reopens an invoice that was paid in full, clearing the paid date', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });
    await k.pay({ paymentAmount: 250, installmentIndex: 1, paidDate: '2026-05-01' });
    await k.pay({ paymentAmount: 250, installmentIndex: 2, paidDate: '2026-06-01' });
    await k.pay({ paymentAmount: 250, installmentIndex: 3, paidDate: '2026-07-01' });
    expect((await k.invoice()).status).toBe('paid');

    const res = await unpay(3);
    expect(res.status).toBe(200);

    const inv = await k.invoice();
    expect(inv.is_paid).toBe(false);
    expect(inv.status).toBe('partially_paid');
    expect(inv.next_payment_date).toBe('2026-07-01');
    const { rows } = await testPool.query('select paid_date from invoices where id = $1', [k.invoiceId]);
    expect(rows[0].paid_date).toBeNull();
    await k.expectScheduleMatchesBalance(undefined, 'unpay last');
  });

});
