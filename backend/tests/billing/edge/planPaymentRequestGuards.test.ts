/**
 * The ways a payment request can name an instalment the schedule cannot take, and the
 * payment shapes that must keep the open rows equal to the balance.
 */
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);

beforeEach(async () => {
  expect((await k.setPlan()).status).toBe(200);
});

describe('an instalment index past the end of the schedule', () => {
  it('is refused and records nothing', async () => {
    const res = await k.pay({ paymentAmount: 250, installmentIndex: 4, paidDate: '2026-04-01' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/no longer exists/i);
    expect(await k.payments()).toHaveLength(0);
    expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
  });

  it('is accepted on the last row of the schedule', async () => {
    const res = await k.pay({ paymentAmount: 250, installmentIndex: 3, paidDate: '2026-07-01' });

    expect(res.status).toBe(200);
    expect((await k.rows())[3].status).toBe('paid');
  });

  it('is ignored on an invoice that has no plan', async () => {
    const id = await k.createInvoice(1000);
    const res = await k.pay({ paymentAmount: 250, installmentIndex: 9, paidDate: '2026-04-01' }, id);

    expect(res.status).toBe(200);
    expect(await k.payments(id)).toHaveLength(1);
  });
});

describe('marking a plan invoice paid and then unpaid', () => {
  it('reopens every instalment for the whole balance', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });
    expect((await k.pay({ isPaid: true })).status).toBe(200);
    expect((await k.rows()).map((r) => r.status)).toEqual(['paid', 'paid', 'paid', 'paid']);

    expect((await k.pay({ isPaid: false })).status).toBe(200);

    expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
    expect(Number((await k.invoice()).balance_due_cents)).toBe(100_000);
    await k.expectScheduleMatchesBalance(undefined, 'paid then unpaid');
  });

  it('links the instalments it settles to the top-up payment, so deleting that payment reopens only them', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });
    await k.pay({ isPaid: true });
    expect((await k.rows()).map((r) => r.matched_payment_index)).toEqual([0, 1, 1, 1]);

    expect((await k.owner.api.delete(k.on('/payment?paymentIndex=1'))).status).toBe(200);

    expect(await k.shape()).toEqual([[25_000, 'paid'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
    await k.expectScheduleMatchesBalance(undefined, 'delete the top-up');
  });
});

describe('a payment spread across several rows', () => {
  it('tracks the balance through payment, edit, delete and un-pay in turn', async () => {
    await k.pay({ paymentAmount: 600, installmentIndex: 1, paidDate: '2026-05-01' });
    await k.expectScheduleMatchesBalance(undefined, 'pay 600 at row 1');
    expect(Number((await k.invoice()).balance_due_cents)).toBe(40_000);

    expect((await k.owner.api.patch(k.on('/payment')).send({ paymentIndex: 0, amount: 900 })).status).toBe(200);
    await k.expectScheduleMatchesBalance(undefined, 'edit up to 900');
    expect(Number((await k.invoice()).balance_due_cents)).toBe(10_000);

    expect((await k.owner.api.delete(k.on('/payment-plan/installment/1/payment'))).status).toBe(200);
    await k.expectScheduleMatchesBalance(undefined, 'un-pay the named row');
    expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
  });
});
