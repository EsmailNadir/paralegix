/**
 * A monthly plan anchors every date on the start day (date i is the start plus i months, clamped to the month end), matching the form preview.
 */
import { usePlanKit } from './planKit';

const k = usePlanKit(1200);

async function datesFor(start: string, extra: Record<string, unknown> = {}) {
  const id = await k.createInvoice(1200);
  expect((await k.setPlan({ installmentAmount: 100, planStartDate: start, ...extra }, id)).status).toBe(200);
  return (await k.rows(id)).map((r) => r.due_date);
}

it('returns to the 31st after February instead of staying on the 28th', async () => {
  const d = await datesFor('2026-01-31');
  expect(d.slice(0, 5)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
});

it('returns to the 30th after February', async () => {
  const d = await datesFor('2026-01-30');
  expect(d.slice(0, 4)).toEqual(['2026-01-30', '2026-02-28', '2026-03-30', '2026-04-30']);
});

it('returns to the 31st after a leap February', async () => {
  const d = await datesFor('2028-01-31');
  expect(d.slice(0, 4)).toEqual(['2028-01-31', '2028-02-29', '2028-03-31', '2028-04-30']);
});

it('does not walk a 31st start down through the 30-day months', async () => {
  const d = await datesFor('2026-03-31');
  expect(d.slice(0, 5)).toEqual(['2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31']);
});

it('anchors the regular instalments after a down payment on the start day', async () => {
  const d = await datesFor('2026-01-31', { downPaymentAmount: 200, downPaymentDueDate: '2026-01-31' });
  expect(d.slice(0, 3)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
});

describe('rows added after the plan was set stay on the start day', () => {
  async function planFromJan31(total: number, installment: number) {
    const id = await k.createInvoice(total);
    expect((await k.setPlan({ installmentAmount: installment, planStartDate: '2026-01-31' }, id)).status).toBe(200);
    return id;
  }

  it('dates an amount added to the plan on the 31st after a short month', async () => {
    const id = await planFromJan31(200, 100); // 31 Jan, 28 Feb
    expect((await k.owner.api.patch(k.on('/add-amount', id)).send({ amount: 100 })).status).toBe(200);
    expect((await k.owner.api.patch(k.on('/add-amount', id)).send({ amount: 100 })).status).toBe(200);

    expect((await k.rows(id)).map((r) => r.due_date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('dates a carried shortfall that needs a new row on the 31st', async () => {
    const id = await planFromJan31(200, 100);
    const res = await k.pay({ paymentAmount: 40, installmentIndex: 1, shortfallAction: 'add_to_next', paidDate: '2026-02-01' }, id);

    expect(res.status).toBe(200);
    expect((await k.rows(id)).map((r) => r.due_date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    await k.expectScheduleMatchesBalance(id, 'carried shortfall');
  });

  it('dates the rows a refit regrows past the last known date on the 31st', async () => {
    const id = await planFromJan31(400, 100); // 31 Jan, 28 Feb, 31 Mar, 30 Apr
    const credit = await k.owner.api.post(k.on('/credit-note', id)).send({ amount: 300, type: 'write_off' });
    expect(credit.status).toBe(200);
    expect((await k.rows(id)).map((r) => r.due_date)).toEqual(['2026-01-31']);

    const noteId = credit.body.invoice.creditNotes[0].id;
    expect((await k.owner.api.delete(k.on(`/credit-note?creditNoteId=${noteId}`, id))).status).toBe(200);

    expect((await k.rows(id)).map((r) => r.due_date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    await k.expectScheduleMatchesBalance(id, 'refit regrown');
  });

  it('dates the row a lowered last instalment adds on the 31st', async () => {
    const id = await planFromJan31(300, 100); // 31 Jan, 28 Feb, 31 Mar
    const res = await k.owner.api.patch(k.on('/payment-plan/installment/2', id)).send({ amount: 50 });

    expect(res.status).toBe(200);
    expect((await k.rows(id)).map((r) => r.due_date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    await k.expectScheduleMatchesBalance(id, 'lowered last row');
  });
});
