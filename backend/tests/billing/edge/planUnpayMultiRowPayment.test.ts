/**
 * Un-paying an instalment reopens every instalment the removed payment settled.
 */
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);
const unpay = (index: number) => k.owner.api.delete(k.on(`/payment-plan/installment/${index}/payment`));

beforeEach(async () => {
  expect((await k.setPlan()).status).toBe(200);
});

it('reopens every instalment a single payment had covered', async () => {
  await k.pay({ paymentAmount: 600, installmentIndex: 0, paidDate: '2026-04-01' });

  const res = await unpay(0);
  expect(res.status).toBe(200);

  expect(await k.payments()).toHaveLength(0);
  expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
  await k.expectScheduleMatchesBalance(undefined, 'unpay cascade');
});
