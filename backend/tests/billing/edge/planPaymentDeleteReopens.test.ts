/**
 * Deleting a payment reopens every instalment it had settled, so the schedule goes back to what it was before the payment existed.
 */
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);
const DATES = ['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01'];
const del = (paymentIndex: number) => k.owner.api.delete(k.on(`/payment?paymentIndex=${paymentIndex}`));

beforeEach(async () => {
  expect((await k.setPlan()).status).toBe(200);
});

describe('deleting a payment', () => {
  it('reopens the instalment the payment had settled and restores the schedule', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });

    const res = await del(0);
    expect(res.status).toBe(200);

    // Nothing has been paid, so nothing is settled: the same four instalments
    // are owed, not a paid one that no payment backs plus a fifth.
    expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
    expect((await k.rows()).map((r) => r.due_date)).toEqual(DATES);
    expect((await k.invoice()).next_payment_date).toBe('2026-04-01');
    await k.expectScheduleMatchesBalance(undefined, 'delete settled');
  });
});


describe('deleting a payment', () => {
  it('reopens both instalments a single large payment had covered', async () => {
    await k.pay({ paymentAmount: 600, installmentIndex: 0, paidDate: '2026-04-01' });

    const res = await del(0);
    expect(res.status).toBe(200);

    expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
    await k.expectScheduleMatchesBalance(undefined, 'delete cascade');
  });
});


describe('deleting a payment', () => {
  it('reopens only the instalment of the deleted payment and re-points the survivor', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });
    await k.pay({ paymentAmount: 250, installmentIndex: 1, paidDate: '2026-05-01' });

    const res = await del(0);
    expect(res.status).toBe(200);

    const rows = await k.rows();
    expect(rows.map((r) => r.status)).toEqual(['pending', 'paid', 'pending', 'pending']);
    expect(rows[1].matched_payment_index).toBe(0);
    expect(await k.payments()).toHaveLength(1);
    await k.expectScheduleMatchesBalance(undefined, 'delete first of two');
  });
});


describe('deleting a payment', () => {
  it('reopens the instalments of a plan that was marked paid outright', async () => {
    await k.pay({ isPaid: true });
    expect((await k.rows()).map((r) => r.status)).toEqual(['paid', 'paid', 'paid', 'paid']);

    const res = await del(0);
    expect(res.status).toBe(200);

    expect(Number((await k.invoice()).balance_due_cents)).toBe(100_000);
    expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
    await k.expectScheduleMatchesBalance(undefined, 'delete topup');
  });
});


describe('a down payment that was already received', () => {
  it('reopens the down payment instalment when its payment is deleted', async () => {
    const id = await k.createInvoice(1000);
    expect((await k.setPlan({ installmentAmount: 400, downPaymentAmount: 200, downPaymentAlreadyPaid: true }, id)).status).toBe(200);

    const res = await k.owner.api.delete(k.on('/payment?paymentIndex=0', id));
    expect(res.status).toBe(200);

    const rows = await k.rows(id);
    expect(rows.filter((r) => r.is_down_payment).map((r) => r.status)).toEqual(['pending']);
    expect(Number((await k.invoice(id)).balance_due_cents)).toBe(100_000);
    await k.expectScheduleMatchesBalance(id, 'delete down payment');
  });
});
