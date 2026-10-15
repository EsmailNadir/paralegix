/**
 * A late fee is added to the next open instalment, so the open rows keep covering the balance.
 */
import { testPool } from '../../support/setupInProcess';
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);

async function lateFeeOn() {
  await testPool.query(
    `update law_firms set settings = coalesce(settings, '{}'::jsonb)
       || jsonb_build_object('billing', jsonb_build_object('lateFee',
            '{"enabled": true, "flatAmount": 25, "percent": 0, "graceDays": 0}'::jsonb)) where id = $1`,
    [k.firm.id]);
}

it('keeps the open instalments equal to the balance right after a late fee', async () => {
  await lateFeeOn();
  await k.setPlan();
  expect((await k.owner.api.post(k.on('/late-fee')).send({})).status).toBe(200);

  await k.expectScheduleMatchesBalance(undefined, 'after late fee');
});

it('leaves a next payment date for a fee still owed after every instalment is paid', async () => {
  await lateFeeOn();
  await k.setPlan();
  await k.owner.api.post(k.on('/late-fee')).send({});
  await k.pay({ paymentAmount: 1000, paidDate: '2026-04-02' });

  const inv = await k.invoice();
  expect(Number(inv.balance_due_cents)).toBe(2_500);
  expect(inv.next_payment_date).not.toBeNull();
});

it('puts the fee on the next open instalment, so the schedule covers the balance at once', async () => {
  await lateFeeOn();
  await k.setPlan();
  expect((await k.owner.api.post(k.on('/late-fee')).send({})).status).toBe(200);

  expect(await k.shape()).toEqual([[27_500, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
  const inv = await k.invoice();
  expect(inv.next_payment_date).toBe('2026-04-01');
  expect(Number(inv.balance_due_cents)).toBe(102_500);
});

it('keeps the fee covered when a later balance change refits the schedule', async () => {
  await lateFeeOn();
  await k.setPlan();
  await k.owner.api.post(k.on('/late-fee')).send({});
  expect((await k.owner.api.post(k.on('/credit-note')).send({ amount: 1, type: 'discount' })).status).toBe(200);

  expect(Number((await k.invoice()).balance_due_cents)).toBe(102_400);
  await k.expectScheduleMatchesBalance(undefined, 'credit note after late fee');
});

it('lands the fee on the earliest open instalment by date, past a paid one', async () => {
  await lateFeeOn();
  await k.setPlan();
  await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });
  expect((await k.owner.api.post(k.on('/late-fee')).send({})).status).toBe(200);

  expect(await k.shape()).toEqual([[25_000, 'paid'], [27_500, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
  await k.expectScheduleMatchesBalance(undefined, 'late fee past a paid row');
});
