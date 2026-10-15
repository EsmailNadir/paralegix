/**
 * Un-paying an instalment settled short with add_to_next restores that row and the next row to their original amounts.
 */
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);

beforeEach(async () => {
  expect((await k.setPlan()).status).toBe(200);
});

it('restores the shortfall carried onto the next instalment when the short payment is reversed', async () => {
  await k.pay({ paymentAmount: 150, installmentIndex: 0, shortfallAction: 'add_to_next', paidDate: '2026-04-01' });
  expect(await k.shape()).toEqual([[15_000, 'paid'], [35_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);

  const res = await k.owner.api.delete(k.on('/payment-plan/installment/0/payment'));
  expect(res.status).toBe(200);

  expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
  await k.expectScheduleMatchesBalance(undefined, 'unpay add_to_next');
});
