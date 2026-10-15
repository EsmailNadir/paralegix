/**
 * Editing a payment that settled an instalment settles the schedule again for the new amount.
 */
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);

beforeEach(async () => {
  expect((await k.setPlan()).status).toBe(200);
});

it('does not leave a settled instalment reading as paid for more than its payment now is', async () => {
  await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });

  const res = await k.owner.api.patch(k.on('/payment')).send({ paymentIndex: 0, amount: 100 });
  expect(res.status).toBe(200);

  const rows = await k.rows();
  const paidClaim = rows.filter((r) => r.matched_payment_index === 0 && r.status === 'paid')
    .reduce((sum, r) => sum + Number(r.amount_cents), 0);
  expect(paidClaim).toBeLessThanOrEqual(10_000);
  await k.expectScheduleMatchesBalance(undefined, 'edit settled payment');
});

const edit = (paymentIndex: number, amount: number) =>
  k.owner.api.patch(k.on('/payment')).send({ paymentIndex, amount });

it('reopens the settled instalment at its remaining amount when the payment is corrected down', async () => {
  await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });
  expect((await edit(0, 100)).status).toBe(200);

  expect(await k.shape()).toEqual([[15_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
  expect(Number((await k.invoice()).balance_due_cents)).toBe(90_000);
});

it('settles the next instalment too when the payment is corrected up past the first', async () => {
  await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });
  expect((await edit(0, 400)).status).toBe(200);

  expect(await k.shape()).toEqual([[25_000, 'paid'], [10_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
  const rows = await k.rows();
  expect([rows[0].matched_payment_index, rows[1].matched_payment_index]).toEqual([0, null]);
  await k.expectScheduleMatchesBalance(undefined, 'edit up past an instalment');
});

it('settles from the same instalment when the payment named a later one', async () => {
  await k.pay({ paymentAmount: 250, installmentIndex: 2, paidDate: '2026-06-01' });
  expect((await edit(0, 300)).status).toBe(200);

  expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending'], [25_000, 'paid'], [20_000, 'pending']]);
  await k.expectScheduleMatchesBalance(undefined, 'edit a named later instalment');
});

it('keeps the paid instalments when the corrected payment settles the whole invoice', async () => {
  await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });
  expect((await edit(0, 1000)).status).toBe(200);

  const inv = await k.invoice();
  expect(inv.payment_plan_enabled).toBe(true);
  expect(inv.is_paid).toBe(true);
  expect(inv.next_payment_date).toBeNull();
  expect((await k.rows()).map((r) => r.status)).toEqual(['paid', 'paid', 'paid', 'paid']);
});

it('leaves the schedule alone when only the date of the payment changes', async () => {
  await k.pay({ paymentAmount: 250, installmentIndex: 1, paidDate: '2026-05-01' });
  const before = await k.rows();
  const res = await k.owner.api.patch(k.on('/payment')).send({ paymentIndex: 0, date: '2026-05-02' });

  expect(res.status).toBe(200);
  expect(await k.rows()).toEqual(before);
});

it('keeps an unnamed part payment on the front instalment when it is corrected', async () => {
  await k.pay({ paymentAmount: 100, paidDate: '2026-04-01' });
  expect((await edit(0, 60)).status).toBe(200);

  expect(await k.shape()).toEqual([[19_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
  expect((await k.rows()).map((r) => r.matched_payment_index)).toEqual([null, null, null, null]);
});
