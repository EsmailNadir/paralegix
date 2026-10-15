/**
 * Status and overdue-ness of an invoice on a payment plan.
 *
 * Fixtures: a $1,000 invoice on two $500 instalments due 1 May and 1 June 2026.
 * Overdue is a calendar-day comparison: an instalment is overdue the day AFTER
 * its due day, and "the day" is the viewer's.
 */
import { freezeClockAt, unfreezeClock } from '../../support/setupInProcess';
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);

/** The invoice as the client-level list and the firm list report it, for a viewer in `tz`. */
async function seenFrom(tz: string) {
  const detail = await k.owner.api.get(k.base()).set('x-timezone', tz);
  const firm = await k.owner.api.get(`/api/lawfirms/${k.firm.id}/billing/invoices/firm`).set('x-timezone', tz);
  const pick = (body: any) => body.invoices.find((i: any) => i.id === k.invoiceId);
  return { detail: pick(detail.body), firm: pick(firm.body) };
}

const rowStatuses = (invoice: any) => invoice.paymentPlan.expectedPayments.map((e: any) => e.status);

beforeEach(async () => {
  expect((await k.setPlan({ installmentAmount: 500, planStartDate: '2026-05-01' })).status).toBe(200);
});

afterEach(() => unfreezeClock());

describe('the invoice status moves with the payments', () => {
  it('goes outstanding, then partially paid, then paid, then back to partially paid', async () => {
    freezeClockAt('2026-04-20T12:00:00-07:00');
    const statusNow = async () => (await seenFrom('America/Los_Angeles')).detail;
    expect((await statusNow()).status).toBe('outstanding');

    await k.pay({ paymentAmount: 500, installmentIndex: 0, paidDate: '2026-04-20' });
    expect(((await statusNow()).status)).toBe('partially_paid');
    expect((await k.invoice()).is_paid).toBe(false);

    await k.pay({ paymentAmount: 500, installmentIndex: 1, paidDate: '2026-04-20' });
    let inv = await k.invoice();
    expect([(await statusNow()).status, inv.is_paid, inv.next_payment_date]).toEqual(['paid', true, null]);

    expect((await k.owner.api.delete(k.on('/payment?paymentIndex=1'))).status).toBe(200);
    inv = await k.invoice();
    expect([(await statusNow()).status, inv.is_paid, Number(inv.balance_due_cents)]).toEqual(['partially_paid', false, 50_000]);
    await k.expectScheduleMatchesBalance(undefined, 'transitions');
  });
});

describe('the day an instalment becomes overdue', () => {
  it('is not overdue at noon on its due day and is the morning after', async () => {
    freezeClockAt('2026-05-01T12:00:00-07:00');
    const onDay = await seenFrom('America/Los_Angeles');
    expect(onDay.detail.status).toBe('outstanding');
    expect(rowStatuses(onDay.detail)).toEqual(['pending', 'pending']);
    expect(onDay.firm.status).toBe('outstanding');

    unfreezeClock();
    freezeClockAt('2026-05-02T09:00:00-07:00');
    const after = await seenFrom('America/Los_Angeles');
    expect(after.detail.status).toBe('overdue');
    expect(rowStatuses(after.detail)).toEqual(['overdue', 'pending']);
    expect(after.firm.status).toBe('overdue');
  });

  it('puts the invoice in the overdue filter exactly when the firm list calls it overdue', async () => {
    freezeClockAt('2026-05-02T09:00:00-07:00');

    const res = await k.owner.api.get(`/api/lawfirms/${k.firm.id}/billing/invoices/firm?status=overdue`)
      .set('x-timezone', 'America/Los_Angeles');

    expect(res.body.invoices.map((i: any) => i.id)).toEqual([k.invoiceId]);
  });

});

