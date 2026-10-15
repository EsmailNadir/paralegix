/**
 * How recorded payments line up against a payment plan's instalments.
 *
 * A $1,000 invoice on a four-instalment plan ($250 on the first of April to
 * July) is paid every way a firm can pay it: short of an instalment, exactly
 * one, several at once, the whole balance, with and without naming an
 * instalment, then taken back off again by deleting or editing the payment.
 *
 * After EVERY mutation the instalments still owed must add up to the balance
 * the invoice reports. A schedule that disagrees with the balance collects the
 * wrong amount while every screen agrees with itself.
 */
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);

const DATES = ['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01'];

const del = (paymentIndex: number) => k.owner.api.delete(k.on(`/payment?paymentIndex=${paymentIndex}`));

beforeEach(async () => {
  const res = await k.setPlan();
  expect(res.status).toBe(200);
  expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
});

describe('a payment smaller than the next instalment', () => {
  it('part-pays the front instalment, links nothing and keeps the first open date as the next payment', async () => {
    const res = await k.pay({ paymentAmount: 100, paidDate: '2026-04-01' });
    expect(res.status).toBe(200);

    expect(await k.shape()).toEqual([[15_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
    expect((await k.rows()).map((r) => r.matched_payment_index)).toEqual([null, null, null, null]);
    const inv = await k.invoice();
    expect(Number(inv.balance_due_cents)).toBe(90_000);
    expect(inv.status).toBe('partially_paid');
    expect(inv.next_payment_date).toBe('2026-04-01');
    await k.expectScheduleMatchesBalance(undefined, 'partial');
  });

  it('settles the front instalment when two part payments add up to it, pointing it at the payment that closed it', async () => {
    await k.pay({ paymentAmount: 100, paidDate: '2026-04-01' });
    const res = await k.pay({ paymentAmount: 150, paidDate: '2026-04-02' });
    expect(res.status).toBe(200);

    const rows = await k.rows();
    expect(rows[0]).toMatchObject({ status: 'paid', amount_cents: '15000', matched_payment_index: 1 });
    expect(Number((await k.invoice()).balance_due_cents)).toBe(75_000);
    expect(rows[1].due_date).toBe('2026-05-01');
    await k.expectScheduleMatchesBalance(undefined, 'two partials');
  });
});

describe('a payment of exactly one instalment', () => {
  it('settles the named later instalment and leaves the earlier ones owing', async () => {
    const res = await k.pay({ paymentAmount: 250, installmentIndex: 2, paidDate: '2026-06-01' });
    expect(res.status).toBe(200);

    expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending'], [25_000, 'paid'], [25_000, 'pending']]);
    expect((await k.rows()).map((r) => r.matched_payment_index)).toEqual([null, null, 0, null]);
    expect((await k.invoice()).next_payment_date).toBe('2026-04-01');
    await k.expectScheduleMatchesBalance(undefined, 'index 2');
  });

  it('moves the next payment date to the following instalment when the front one is paid unnamed', async () => {
    await k.pay({ paymentAmount: 250, paidDate: '2026-04-01' });

    expect(await k.shape()).toEqual([[25_000, 'paid'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
    expect((await k.invoice()).next_payment_date).toBe('2026-05-01');
    await k.expectScheduleMatchesBalance(undefined, 'exact unnamed');
  });
});

describe('a payment of more than one instalment', () => {
  it('skips instalments that are already paid when an unnamed payment walks the schedule', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 1, paidDate: '2026-05-01' });
    const res = await k.pay({ paymentAmount: 400, paidDate: '2026-05-02' });
    expect(res.status).toBe(200);

    // 250 settles the first instalment, 150 part-pays the third. The paid
    // second instalment is stepped over, not paid twice.
    expect(await k.shape()).toEqual([[25_000, 'paid'], [25_000, 'paid'], [10_000, 'pending'], [25_000, 'pending']]);
    const rows = await k.rows();
    expect(rows[0].matched_payment_index).toBe(1);
    expect(rows[1].matched_payment_index).toBe(0);
    expect(Number((await k.invoice()).balance_due_cents)).toBe(35_000);
    await k.expectScheduleMatchesBalance(undefined, 'unnamed after named');
  });

  it('applies the excess of a payment named at a later instalment to the instalments after it', async () => {
    const res = await k.pay({ paymentAmount: 400, installmentIndex: 1, paidDate: '2026-05-01' });
    expect(res.status).toBe(200);

    expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'paid'], [10_000, 'pending'], [25_000, 'pending']]);
    await k.expectScheduleMatchesBalance(undefined, 'overpay index 1');
  });
});

describe('a payment equal to the whole balance', () => {
  it('settles every instalment and the invoice when it is unnamed', async () => {
    const res = await k.pay({ paymentAmount: 1000, paidDate: '2026-04-01' });
    expect(res.status).toBe(200);

    expect((await k.rows()).map((r) => r.status)).toEqual(['paid', 'paid', 'paid', 'paid']);
    const inv = await k.invoice();
    expect(inv.is_paid).toBe(true);
    expect(inv.status).toBe('paid');
    expect(inv.next_payment_date).toBeNull();
    expect(Number(inv.balance_due_cents)).toBe(0);
  });

});

describe('an overpayment that outruns the instalments after the named one', () => {

});

describe('deleting a payment', () => {

  it('restores an unnamed part payment to the instalment it reduced', async () => {
    await k.pay({ paymentAmount: 100, paidDate: '2026-04-01' });

    const res = await del(0);
    expect(res.status).toBe(200);

    expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
    await k.expectScheduleMatchesBalance(undefined, 'delete partial');
  });

  it('moves an invoice that was paid in full back to partially paid', async () => {
    await k.pay({ paymentAmount: 750, paidDate: '2026-04-01' });
    await k.pay({ paymentAmount: 250, paidDate: '2026-04-02' });
    expect((await k.invoice()).status).toBe('paid');

    const res = await del(1);
    expect(res.status).toBe(200);

    const inv = await k.invoice();
    expect(inv.is_paid).toBe(false);
    expect(inv.status).toBe('partially_paid');
    expect(Number(inv.amount_paid_cents)).toBe(75_000);
    expect(Number(inv.balance_due_cents)).toBe(25_000);
    await k.expectScheduleMatchesBalance(undefined, 'paid to partial');
  });

  it('refuses a payment index that does not exist and changes nothing', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });
    const before = await k.rows();

    const res = await del(5);

    expect(res.status).toBe(400);
    expect(await k.rows()).toEqual(before);
    expect(await k.payments()).toHaveLength(1);
  });
});

describe('editing a payment amount', () => {
  const edit = (paymentIndex: number, amount: number) =>
    k.owner.api.patch(k.on('/payment')).send({ paymentIndex, amount });

  it('refits the open instalments when an unnamed part payment is corrected down', async () => {
    await k.pay({ paymentAmount: 100, paidDate: '2026-04-01' });

    const res = await edit(0, 60);
    expect(res.status).toBe(200);

    expect(Number((await k.invoice()).balance_due_cents)).toBe(94_000);
    await k.expectScheduleMatchesBalance(undefined, 'edit down');
  });

  it('refits the open instalments when a part payment is corrected up', async () => {
    await k.pay({ paymentAmount: 100, paidDate: '2026-04-01' });

    const res = await edit(0, 300);
    expect(res.status).toBe(200);

    expect(Number((await k.invoice()).balance_due_cents)).toBe(70_000);
    await k.expectScheduleMatchesBalance(undefined, 'edit up');
  });

  it('refuses an edit that would overpay the invoice and leaves the schedule alone', async () => {
    await k.pay({ paymentAmount: 100, paidDate: '2026-04-01' });
    const before = await k.rows();

    const res = await edit(0, 1500);

    expect(res.status).toBe(400);
    expect(await k.rows()).toEqual(before);
  });

});

describe('a shortfall against a named instalment', () => {
  const short = (installmentIndex: number, shortfallAction: string, paymentAmount = 100) =>
    k.pay({ paymentAmount, installmentIndex, shortfallAction, paidDate: '2026-04-01' });

  it.each([0, 2])('forgives the shortfall as a write-off on instalment %i and keeps the others', async (index) => {
    const res = await short(index, 'write_off');
    expect(res.status).toBe(200);

    const inv = await k.invoice();
    expect(Number(inv.total_written_off_cents)).toBe(15_000);
    expect(Number(inv.balance_due_cents)).toBe(75_000);
    const rows = await k.rows();
    expect(rows[index]).toMatchObject({ status: 'paid', amount_cents: '10000', matched_payment_index: 0 });
    await k.expectScheduleMatchesBalance(undefined, `write_off ${index}`);
  });

  it('forgives a shortfall on the LAST instalment without adding one', async () => {
    const res = await short(3, 'write_off');
    expect(res.status).toBe(200);

    expect(await k.rows()).toHaveLength(4);
    expect(Number((await k.invoice()).balance_due_cents)).toBe(75_000);
    await k.expectScheduleMatchesBalance(undefined, 'write_off last');
  });

  it('carries a shortfall on a middle instalment onto the next open one', async () => {
    const res = await short(2, 'add_to_next');
    expect(res.status).toBe(200);

    expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending'], [10_000, 'paid'], [40_000, 'pending']]);
    await k.expectScheduleMatchesBalance(undefined, 'add_to_next middle');
  });

  it('carries a shortfall past a paid instalment onto the next OPEN one', async () => {
    await k.pay({ paymentAmount: 250, installmentIndex: 2, paidDate: '2026-04-01' });
    const res = await short(1, 'add_to_next');
    expect(res.status).toBe(200);

    // The next open instalment after #2 is #4 (index 3): #3 is already paid.
    expect(await k.shape()).toEqual([[25_000, 'pending'], [10_000, 'paid'], [25_000, 'paid'], [40_000, 'pending']]);
    await k.expectScheduleMatchesBalance(undefined, 'add_to_next skips paid');
  });

  it('keeps an instalment open for the remainder across two part payments', async () => {
    await short(1, 'add_to_current', 100);
    const res = await short(1, 'add_to_current', 100);
    expect(res.status).toBe(200);

    expect(await k.shape()).toEqual([[25_000, 'pending'], [5_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
    expect(Number((await k.invoice()).balance_due_cents)).toBe(80_000);
    await k.expectScheduleMatchesBalance(undefined, 'add_to_current twice');
  });

  it('then settles the remainder and closes the instalment', async () => {
    await short(1, 'add_to_current', 100);
    const res = await k.pay({ paymentAmount: 150, installmentIndex: 1, paidDate: '2026-05-02' });
    expect(res.status).toBe(200);

    expect(await k.shape()).toEqual([[25_000, 'pending'], [15_000, 'paid'], [25_000, 'pending'], [25_000, 'pending']]);
    expect(Number((await k.invoice()).balance_due_cents)).toBe(75_000);
    await k.expectScheduleMatchesBalance(undefined, 'add_to_current then settle');
  });

  it('ignores a shortfall action when the payment settles the instalment exactly', async () => {
    const res = await short(0, 'write_off', 250);
    expect(res.status).toBe(200);

    expect((await k.invoice()).total_written_off_cents).toBe('0');
    expect(await k.shape()).toEqual([[25_000, 'paid'], [25_000, 'pending'], [25_000, 'pending'], [25_000, 'pending']]);
    await k.expectScheduleMatchesBalance(undefined, 'shortfall action on exact payment');
  });
});

describe('the payment plan cap of 120 instalments', () => {

});

describe('a down payment that was already received', () => {
  async function planWithPaidDown() {
    const id = await k.createInvoice(1000);
    const res = await k.setPlan({
      installmentAmount: 400, downPaymentAmount: 200, downPaymentAlreadyPaid: true,
    }, id);
    expect(res.status).toBe(200);
    expect(await k.shape(id)).toEqual([[20_000, 'paid'], [40_000, 'pending'], [40_000, 'pending']]);
    return id;
  }

  it('is recorded as the first payment and pointed at by its instalment', async () => {
    const id = await planWithPaidDown();

    expect((await k.payments(id)).map((p) => Number(p.amount_cents))).toEqual([20_000]);
    const rows = await k.rows(id);
    expect(rows[0]).toMatchObject({ is_down_payment: true, status: 'paid', matched_payment_index: 0 });
    expect(Number((await k.invoice(id)).balance_due_cents)).toBe(80_000);
    await k.expectScheduleMatchesBalance(id, 'paid down payment');
  });

  it('reopens the down payment instalment when it is un-paid, leaving the regular rows alone', async () => {
    const id = await planWithPaidDown();

    const res = await k.owner.api.delete(k.on('/payment-plan/installment/0/payment', id));
    expect(res.status).toBe(200);

    expect(await k.shape(id)).toEqual([[20_000, 'pending'], [40_000, 'pending'], [40_000, 'pending']]);
    expect(await k.payments(id)).toHaveLength(0);
    await k.expectScheduleMatchesBalance(id, 'unpay down payment');
  });
});
