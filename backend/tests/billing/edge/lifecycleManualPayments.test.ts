/**
 * Manual payment lifecycle: record, edit, delete, reset, credit, re-price and
 * void, through the real routes, with the money invariants recomputed from
 * Postgres after every mutation.
 *
 * Every spec ends in `assertInvoiceInvariants`, which compares the invoice row
 * to the rows behind it (payments, credit notes), so a mutation that moves one
 * figure and not its partner goes red even when the response body looks right.
 */
import {
  testPool,
  drainEvents,
  sentEmails,
  resetEmails,
} from '../../support/setupInProcess';
import { gateMethod, type Gate } from '../../support/gate';
import {
  seedWorld,
  invoiceRow,
  paymentRows,
  assertInvoiceInvariants,
  type World,
} from './lifecycleKit';

const bus = require('../../../src/shared/events/eventBus');
const invoicesRepo = require('../../../src/modules/billing/invoices/invoices.repository');

let w: World;
let gate: Gate | null = null;
let emitted: Array<{ name: string; payload: any }> = [];
let emitSpy: jest.SpyInstance;

beforeEach(async () => {
  w = await seedWorld(100_000);
  emitted = [];
  const realEmit = bus.emit.bind(bus);
  emitSpy = jest.spyOn(bus, 'emit').mockImplementation((...args: any[]) => {
    emitted.push({ name: args[0], payload: args[1] });
    return realEmit(...args);
  });
  resetEmails();
});

afterEach(() => {
  gate?.restore();
  gate = null;
  emitSpy.mockRestore();
});

const pay = (body: Record<string, unknown>) => w.owner.api.put(`${w.inv}/payment`).send(body);
const received = () => emitted.filter((e) => e.name === 'invoice.paymentReceived');
const receipts = () => sentEmails().filter((e) => /received your payment/i.test(e.text || ''));

describe('status and paid-date transitions across a payment history', () => {
  it('walks outstanding, partially_paid, paid and back as payments are added and one is deleted', async () => {
    expect((await invoiceRow(w.invoiceId)).status).toBe('outstanding');

    expect((await pay({ paymentAmount: 400.01 })).status).toBe(200);
    let { row } = await assertInvoiceInvariants(w.invoiceId);
    expect(row.status).toBe('partially_paid');
    expect(Number(row.amount_paid_cents)).toBe(40_001);
    expect(row.paid_date).toBeNull();

    expect((await pay({ paymentAmount: 599.99, paidDate: '2026-02-03' })).status).toBe(200);
    ({ row } = await assertInvoiceInvariants(w.invoiceId));
    expect(row.status).toBe('paid');
    expect(row.is_paid).toBe(true);
    expect(row.paid_date).not.toBeNull();

    // Removing the first payment reopens the invoice and clears the settlement date.
    const del = await w.owner.api.delete(`${w.inv}/payment?paymentIndex=0`);
    expect(del.status).toBe(200);
    ({ row } = await assertInvoiceInvariants(w.invoiceId));
    expect(row.status).toBe('partially_paid');
    expect(Number(row.amount_paid_cents)).toBe(59_999);
    expect(row.is_paid).toBe(false);
    expect(row.paid_date).toBeNull();
    expect((await paymentRows(w.invoiceId)).map((p: any) => p.cents)).toEqual([59_999]);
  });

  it('marking an invoice paid twice adds one balancing payment, not two, and announces one payment', async () => {
    await pay({ paymentAmount: 250 });
    await drainEvents();
    resetEmails();
    emitted.length = 0;

    expect((await pay({ isPaid: true })).status).toBe(200);
    await drainEvents();
    const second = await pay({ isPaid: true });
    await drainEvents();

    expect(second.status).toBe(200);
    const { payments, row } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments.map((p: any) => p.cents)).toEqual([25_000, 75_000]);
    expect(Number(row.amount_paid_cents)).toBe(100_000);
    // Only the first isPaid call moved money; the second is a no-op top-up of zero.
    expect(received()).toHaveLength(1);
    expect(receipts()).toHaveLength(1);
  });

  it('a reset to unpaid zeroes the invoice and clears the paid date', async () => {
    await pay({ isPaid: true, paidDate: '2026-01-15' });
    expect((await invoiceRow(w.invoiceId)).paid_date).not.toBeNull();

    const res = await pay({ isPaid: false });

    expect(res.status).toBe(200);
    const { row, payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(row.status).toBe('outstanding');
    expect(row.paid_date).toBeNull();
    expect(payments).toEqual([]);
  });
});

describe('what a payment may be dated', () => {
  it('stores a far-past and a pre-invoice-date payment on the day written', async () => {
    const { rows } = await testPool.query('select invoice_date from invoices where id = $1', [w.invoiceId]);
    expect(rows[0].invoice_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect((await pay({ paymentAmount: 100, paidDate: '1999-12-31' })).status).toBe(200);
    expect((await pay({ paymentAmount: 100, paidDate: '2000-01-01' })).status).toBe(200);

    const { payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments.map((p: any) => p.payment_date)).toEqual(['1999-12-31', '2000-01-01']);
  });

  it('refuses a payment dated on an impossible calendar day and writes nothing', async () => {
    const res = await pay({ paymentAmount: 100, paidDate: '2026-02-30' });

    expect(res.status).toBe(400);
    expect(await paymentRows(w.invoiceId)).toEqual([]);
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('records a future-dated payment against the balance on the day written', async () => {
    const res = await pay({ paymentAmount: 100, paidDate: '2999-01-01' });

    // Policy: a future payment date is accepted and counts immediately. The test
    // pins what the code does so a change to that policy is deliberate.
    expect(res.status).toBe(200);
    const { payments, row } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments[0].payment_date).toBe('2999-01-01');
    expect(Number(row.amount_paid_cents)).toBe(10_000);
  });
});

describe('editing a payment', () => {
  it('raising a payment by exactly the remaining balance settles the invoice, and raising it one cent more is refused', async () => {
    await pay({ paymentAmount: 300 });
    await pay({ paymentAmount: 200 });

    const tooMuch = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentIndex: 0, amount: 800.01 });
    expect(tooMuch.status).toBe(400);
    // Nothing moved on the refusal.
    expect((await paymentRows(w.invoiceId)).map((p: any) => p.cents)).toEqual([30_000, 20_000]);
    await assertInvoiceInvariants(w.invoiceId);

    const exact = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentIndex: 0, amount: 800 });
    expect(exact.status).toBe(200);
    const { row, payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(row.status).toBe('paid');
    expect(payments.map((p: any) => p.cents)).toEqual([80_000, 20_000]);
  });

  it('lowering a payment on a settled invoice reopens it and clears the paid date', async () => {
    await pay({ paymentAmount: 600 });
    await pay({ paymentAmount: 400 });
    expect((await invoiceRow(w.invoiceId)).is_paid).toBe(true);

    const res = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentIndex: 1, amount: 399.99 });

    expect(res.status).toBe(200);
    const { row } = await assertInvoiceInvariants(w.invoiceId);
    expect(row.status).toBe('partially_paid');
    expect(Number(row.amount_paid_cents)).toBe(99_999);
    expect(row.paid_date).toBeNull();
  });

  it('a date-only edit leaves the paid total untouched', async () => {
    await pay({ paymentAmount: 123.45, paidDate: '2026-03-01' });

    const res = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentIndex: 0, date: '2026-03-09', note: 'moved' });

    expect(res.status).toBe(200);
    const { payments, row } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments[0].payment_date).toBe('2026-03-09');
    expect(payments[0].note).toBe('moved');
    expect(Number(row.amount_paid_cents)).toBe(12_345);
  });

  it('an index past the end is refused, not clamped onto another payment', async () => {
    await pay({ paymentAmount: 100 });

    const res = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentIndex: 1, amount: 50 });

    expect(res.status).toBe(400);
    expect((await paymentRows(w.invoiceId)).map((p: any) => p.cents)).toEqual([10_000]);
    const del = await w.owner.api.delete(`${w.inv}/payment?paymentIndex=1`);
    expect(del.status).toBe(400);
    expect((await paymentRows(w.invoiceId)).map((p: any) => p.cents)).toEqual([10_000]);
  });
});

describe('re-pricing an invoice that has payments', () => {
  const lineItems = (amount: number, extra: Record<string, unknown> = {}) =>
    w.owner.api.patch(`${w.inv}/line-items`).send({ flatFees: [{ name: 'Fee', amount }], ...extra });

  it('refuses a total below what was paid, writes nothing, and names the credit it would create', async () => {
    await pay({ paymentAmount: 600 });

    const res = await lineItems(500);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVOICE_TOTAL_BELOW_SETTLED');
    const { row } = await assertInvoiceInvariants(w.invoiceId);
    expect(Number(row.total_cents)).toBe(100_000);
    expect(Number(row.amount_paid_cents)).toBe(60_000);
  });

  it('a total equal to what was paid settles the invoice', async () => {
    await pay({ paymentAmount: 600 });

    const res = await lineItems(600);

    expect(res.status).toBe(200);
    const { row } = await assertInvoiceInvariants(w.invoiceId);
    expect(row.status).toBe('paid');
    expect(Number(row.total_cents)).toBe(60_000);
  });

  it('raising the total of a settled invoice reopens it and clears the paid date', async () => {
    await pay({ isPaid: true });
    expect((await invoiceRow(w.invoiceId)).paid_date).not.toBeNull();

    const res = await lineItems(1500);

    expect(res.status).toBe(200);
    const { row } = await assertInvoiceInvariants(w.invoiceId);
    expect(row.status).toBe('partially_paid');
    expect(row.paid_date).toBeNull();
  });
});

describe('credit notes', () => {
  it('a credit note that clears the whole balance settles the invoice and removing it reopens it', async () => {
    await pay({ paymentAmount: 250 });
    const add = await w.owner.api.post(`${w.inv}/credit-note`).send({ amount: 750, type: 'write_off' });
    expect(add.status).toBe(200);
    let { row } = await assertInvoiceInvariants(w.invoiceId);
    // 250 collected and 750 forgiven: settled by write-off, so credited, not marked paid.
    expect(row.is_paid).toBe(false);
    expect(row.status).toBe('credited');
    expect(Number(row.balance_due_cents)).toBe(0);

    const noteId = add.body.invoice.creditNotes[0].id;
    const del = await w.owner.api.delete(`${w.inv}/credit-note?creditNoteId=${noteId}`);
    expect(del.status).toBe(200);
    ({ row } = await assertInvoiceInvariants(w.invoiceId));
    expect(row.is_paid).toBe(false);
    expect(row.status).toBe('partially_paid');
    expect(Number(row.balance_due_cents)).toBe(75_000);
  });

  it('a write-off beyond the remaining balance after a payment is refused and leaves the invoice unchanged', async () => {
    await pay({ paymentAmount: 900 });

    const res = await w.owner.api.post(`${w.inv}/credit-note`).send({ amount: 100.01, type: 'write_off' });

    expect(res.status).toBe(400);
    const { row } = await assertInvoiceInvariants(w.invoiceId);
    expect(Number(row.total_written_off_cents)).toBe(0);
  });
});

describe('voided and refused payments leave no trace', () => {
  it('a payment on a voided invoice is refused: no row, no event, no receipt', async () => {
    expect((await w.owner.api.post(`${w.inv}/void`).send({})).status).toBe(200);
    resetEmails();
    emitted.length = 0;

    const res = await pay({ paymentAmount: 100 });
    await drainEvents();

    expect(res.status).toBe(409);
    expect(await paymentRows(w.invoiceId)).toEqual([]);
    expect(received()).toHaveLength(0);
    expect(receipts()).toHaveLength(0);
    const row = await invoiceRow(w.invoiceId);
    expect(row.status).toBe('voided');
    expect(Number(row.amount_paid_cents)).toBe(0);
  });

  it('an over-payment is refused with no row, no event and no receipt', async () => {
    await pay({ paymentAmount: 900 });
    await drainEvents();
    resetEmails();
    emitted.length = 0;

    const res = await pay({ paymentAmount: 100.01 });
    await drainEvents();

    expect(res.status).toBe(400);
    expect((await paymentRows(w.invoiceId)).map((p: any) => p.cents)).toEqual([90_000]);
    expect(received()).toHaveLength(0);
    expect(receipts()).toHaveLength(0);
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('a payment whose write fails after the lock rolls back whole: no row, no event, no receipt', async () => {
    gate = gateMethod(invoicesRepo, '_applyUpdateLocked');
    gate.failNext(new Error('injected: invoice write failed'));

    const res = await pay({ paymentAmount: 100 });
    await drainEvents();

    expect(res.status).toBe(500);
    expect(gate.entered()).toBe(1);
    expect(await paymentRows(w.invoiceId)).toEqual([]);
    expect(received()).toHaveLength(0);
    expect(receipts()).toHaveLength(0);
    gate.restore();
    gate = null;
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('sends one receipt per applied payment, with each payment amount', async () => {
    await pay({ paymentAmount: 111.11 });
    await pay({ paymentAmount: 222.22 });
    await drainEvents();

    const mails = receipts();
    expect(mails).toHaveLength(2);
    expect(mails[0].text).toContain('111.11');
    expect(mails[1].text).toContain('222.22');
    expect(received().map((e) => e.payload.amountPaidCents)).toEqual([11_111, 22_222]);
  });
});

describe('every other balance-changing route refuses a voided invoice and writes nothing', () => {
  it('credit note, add amount, line-item edit and payment edit all answer 409 and leave the invoice as voided', async () => {
    expect((await pay({ paymentAmount: 100 })).status).toBe(200);
    expect((await w.owner.api.delete(`${w.inv}/payment?paymentIndex=0`)).status).toBe(200);
    expect((await w.owner.api.post(`${w.inv}/void`).send({})).status).toBe(200);
    const before = await invoiceRow(w.invoiceId);

    const credit = await w.owner.api.post(`${w.inv}/credit-note`).send({ amount: 10, type: 'write_off' });
    const add = await w.owner.api.patch(`${w.inv}/add-amount`).send({ amount: 10 });
    const lines = await w.owner.api.patch(`${w.inv}/line-items`).send({ flatFees: [{ name: 'Fee', amount: 5 }] });
    const edit = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentIndex: 0, amount: 5 });
    const voidAgain = await w.owner.api.post(`${w.inv}/void`).send({});

    expect([credit.status, add.status, lines.status, voidAgain.status]).toEqual([409, 409, 409, 409]);
    expect(edit.status).toBeGreaterThanOrEqual(400);
    expect(await invoiceRow(w.invoiceId)).toEqual({ ...before });
    expect(before.status).toBe('voided');
  });
});

describe('overdue and outstanding across payment changes', () => {
  beforeEach(async () => {
    await testPool.query('update invoices set due_date = current_date - 10 where id = $1', [w.invoiceId]);
    // A write brings the stored status in line with the past due date.
    expect((await pay({ nextPaymentDate: null })).status).toBe(200);
  });

  it('an unpaid past-due invoice is overdue, a payment makes it partially_paid, deleting it returns it to overdue', async () => {
    expect((await invoiceRow(w.invoiceId)).status).toBe('overdue');

    expect((await pay({ paymentAmount: 100 })).status).toBe(200);
    expect((await invoiceRow(w.invoiceId)).status).toBe('partially_paid');

    expect((await w.owner.api.delete(`${w.inv}/payment?paymentIndex=0`)).status).toBe(200);
    expect((await invoiceRow(w.invoiceId)).status).toBe('overdue');
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('paying in full settles it, and "mark unpaid" returns it to overdue with no paid date', async () => {
    expect((await pay({ isPaid: true })).status).toBe(200);
    expect((await invoiceRow(w.invoiceId)).status).toBe('paid');

    expect((await pay({ isPaid: false })).status).toBe(200);
    const row = await invoiceRow(w.invoiceId);
    expect(row.status).toBe('overdue');
    expect(row.paid_date).toBeNull();
  });
});

describe('a total lowered below what was paid, with the overpayment acknowledged', () => {
  it('is recorded as a negative balance with the invoice settled, and the payment rows still add up', async () => {
    await pay({ paymentAmount: 600 });

    const res = await w.owner.api.patch(`${w.inv}/line-items`)
      .send({ flatFees: [{ name: 'Fee', amount: 500 }], acknowledgeOverpayment: true });

    // Policy: the overpayment is accepted and kept as money held beyond the bill.
    expect(res.status).toBe(200);
    const { row, payments } = await assertInvoiceInvariants(w.invoiceId, { allowExcess: true });
    expect(Number(row.total_cents)).toBe(50_000);
    expect(Number(row.amount_paid_cents)).toBe(60_000);
    expect(Number(row.balance_due_cents)).toBe(-10_000);
    expect(row.is_paid).toBe(true);
    expect(payments.map((p: any) => p.cents)).toEqual([60_000]);
  });

  it('deleting the payment afterwards reopens the invoice at its new total', async () => {
    await pay({ paymentAmount: 600 });
    await w.owner.api.patch(`${w.inv}/line-items`)
      .send({ flatFees: [{ name: 'Fee', amount: 500 }], acknowledgeOverpayment: true });

    expect((await w.owner.api.delete(`${w.inv}/payment?paymentIndex=0`)).status).toBe(200);

    const { row } = await assertInvoiceInvariants(w.invoiceId);
    expect(row.status).toBe('outstanding');
    expect(Number(row.balance_due_cents)).toBe(50_000);
  });
});
