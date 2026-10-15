/**
 * A payment named at an instalment is applied across every open row (later rows first, then earlier ones), so the open rows always add up to the balance.
 */
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);

beforeEach(async () => {
  expect((await k.setPlan()).status).toBe(200);
});

it('leaves no instalment owing when the full balance is paid against a later instalment', async () => {
  const res = await k.pay({ paymentAmount: 1000, installmentIndex: 1, paidDate: '2026-04-01' });
  expect(res.status).toBe(200);

  const inv = await k.invoice();
  expect(Number(inv.balance_due_cents)).toBe(0);
  expect(inv.is_paid).toBe(true);
  expect((await k.rows()).filter((r) => r.status !== 'paid')).toEqual([]);
});

it('puts the excess on earlier open instalments when the named one is the last', async () => {
  const res = await k.pay({ paymentAmount: 900, installmentIndex: 3, paidDate: '2026-07-01' });
  expect(res.status).toBe(200);

  expect(Number((await k.invoice()).balance_due_cents)).toBe(10_000);
  await k.expectScheduleMatchesBalance(undefined, 'excess at the last row');
});

it('puts the excess on the earlier open instalments when it outruns the ones after the named one', async () => {
  const res = await k.pay({ paymentAmount: 700, installmentIndex: 2, paidDate: '2026-06-01' });
  expect(res.status).toBe(200);

  expect(Number((await k.invoice()).balance_due_cents)).toBe(30_000);
  await k.expectScheduleMatchesBalance(undefined, 'excess past the end');
});
