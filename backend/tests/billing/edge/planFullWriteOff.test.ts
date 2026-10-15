/**
 * A write-off that settles the invoice keeps the instalments already paid, exactly as a
 * line-item edit does when it settles one, and drops the open ones.
 */
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);

const credit = (amount: number) => k.owner.api.post(k.on('/credit-note')).send({ amount, type: 'write_off' });

beforeEach(async () => {
  expect((await k.setPlan()).status).toBe(200);
});

it('keeps the paid instalments and removes the open ones when a credit note covers the balance', async () => {
  await k.pay({ paymentAmount: 500, installmentIndex: 0, paidDate: '2026-04-01' });
  expect((await credit(500)).status).toBe(200);

  const inv = await k.invoice();
  expect(inv.payment_plan_enabled).toBe(true);
  expect(inv.next_payment_date).toBeNull();
  expect(Number(inv.balance_due_cents)).toBe(0);
  expect(await k.shape()).toEqual([[25_000, 'paid'], [25_000, 'paid']]);
  expect((await k.rows()).map((r) => r.matched_payment_index)).toEqual([0, 0]);
});

it('drops the plan when nothing was paid and the credit note covers the whole balance', async () => {
  expect((await credit(1000)).status).toBe(200);

  const inv = await k.invoice();
  expect(inv.payment_plan_enabled).toBe(false);
  expect(await k.rows()).toEqual([]);
});

it('brings the open instalments back when the covering credit note is deleted', async () => {
  await k.pay({ paymentAmount: 500, installmentIndex: 0, paidDate: '2026-04-01' });
  const res = await credit(500);
  const noteId = res.body.invoice.creditNotes[0].id;

  expect((await k.owner.api.delete(k.on(`/credit-note?creditNoteId=${noteId}`))).status).toBe(200);

  expect(await k.shape()).toEqual([[25_000, 'paid'], [25_000, 'paid'], [25_000, 'pending'], [25_000, 'pending']]);
  await k.expectScheduleMatchesBalance(undefined, 'credit note deleted after a full write-off');
});
