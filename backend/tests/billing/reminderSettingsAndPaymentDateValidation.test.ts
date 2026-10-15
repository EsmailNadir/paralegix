/**
 * Bad input on the reminder settings and the payment-date edit is a 400 that
 * writes nothing, not a 500 from Postgres and not a silent coercion.
 */
import {
  testPool,
  createFirm,
  createInvoice,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let clientId: string;
let invoiceId: string;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}/${invoiceId}`;

async function reminderRow() {
  const { rows } = await testPool.query(
    'select is_opted_out, pre_due_days from reminders where invoice_id = $1', [invoiceId],
  );
  return rows[0] || null;
}

async function planPreDays() {
  const { rows } = await testPool.query('select plan_pre_reminder_days from invoices where id = $1', [invoiceId]);
  return rows[0].plan_pre_reminder_days;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  clientId = (await createPersonClient(firm.id, { name: 'Valid Client' })).id;
  invoiceId = (await createInvoice(firm.id, clientId, { totalCents: 10_000 })).id;
});

describe('PATCH pre-due-reminder', () => {
  /** RED IF unvalidated: 'abc' and 2.5 are 500s, -1 is stored, a junk planDays is a silent 200. */
  it.each([
    [{ invoiceDays: 'abc' }],
    [{ invoiceDays: -1 }],
    [{ invoiceDays: 2.5 }],
    [{ invoiceDays: 400 }],
    [{ planDays: 'x' }],
  ])('refuses %j and writes nothing', async (body) => {
    const res = await owner.api.patch(`${B()}/pre-due-reminder`).send(body);

    expect(res.status).toBe(400);
    expect(await reminderRow()).toBeNull();
    expect(await planPreDays()).toBeNull();
  });

  it('stores a whole number of days, and clears it with null', async () => {
    expect((await owner.api.patch(`${B()}/pre-due-reminder`).send({ invoiceDays: 3 })).status).toBe(200);
    expect((await reminderRow()).pre_due_days).toBe(3);

    expect((await owner.api.patch(`${B()}/pre-due-reminder`).send({ invoiceDays: null })).status).toBe(200);
    expect((await reminderRow()).pre_due_days).toBeNull();
  });
});

describe('PATCH reminder-optout', () => {
  /** RED IF unvalidated: 'no' is not `false`, so the invoice is opted OUT with a 200. */
  it('refuses a non-boolean and leaves reminders on', async () => {
    const res = await owner.api.patch(`${B()}/reminder-optout`).send({ optOut: 'no' });

    expect(res.status).toBe(400);
    expect(await reminderRow()).toBeNull();
  });

  it('still opts out with true, back in with false, and out with an empty body', async () => {
    expect((await owner.api.patch(`${B()}/reminder-optout`).send({ optOut: true })).status).toBe(200);
    expect((await reminderRow()).is_opted_out).toBe(true);
    expect((await owner.api.patch(`${B()}/reminder-optout`).send({ optOut: false })).status).toBe(200);
    expect((await reminderRow()).is_opted_out).toBe(false);
    expect((await owner.api.patch(`${B()}/reminder-optout`).send({})).status).toBe(200);
    expect((await reminderRow()).is_opted_out).toBe(true);
  });
});

describe('PATCH payment (edit) date', () => {
  beforeEach(async () => {
    const res = await owner.api.put(`${B()}/payment`).send({ paymentAmount: 50, paidDate: '2026-03-10' });
    expect(res.status).toBe(200);
  });

  async function paymentDay() {
    const { rows } = await testPool.query('select payment_date from invoice_payments where invoice_id = $1', [invoiceId]);
    return rows[0].payment_date;
  }

  /** RED IF unvalidated: the impossible day is a 500, the garbage string is coerced and saved. */
  it.each(['2026-02-30', 'not-a-date', '03/05/2026'])('refuses %p and keeps the recorded day', async (date) => {
    const res = await owner.api.patch(`${B()}/payment`).send({ paymentIndex: 0, date });

    expect(res.status).toBe(400);
    expect(await paymentDay()).toBe('2026-03-10');
  });

  it('accepts a real day, and an empty string still means "unchanged"', async () => {
    expect((await owner.api.patch(`${B()}/payment`).send({ paymentIndex: 0, date: '2026-03-05' })).status).toBe(200);
    expect(await paymentDay()).toBe('2026-03-05');

    expect((await owner.api.patch(`${B()}/payment`).send({ paymentIndex: 0, date: '' })).status).toBe(200);
    expect(await paymentDay()).toBe('2026-03-05');
  });
});
