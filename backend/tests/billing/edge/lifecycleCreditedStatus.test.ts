/**
 * How an invoice reached a zero balance decides its label. Cash that covers the
 * balance reads paid; a write-off that clears the remainder reads credited, since
 * the firm forgave that money and did not collect it. Credited invoices are no
 * longer owed anything, so every surface that chases or lists money owed leaves
 * them out.
 */
import { testPool } from '../../support/setupInProcess';
import { seedWorld, invoiceRow, assertInvoiceInvariants, type World } from './lifecycleKit';

let w: World;
beforeEach(async () => { w = await seedWorld(100_000); });
const pay = (b: any) => w.owner.api.put(`${w.inv}/payment`).send(b);
const writeOff = (amount: number) => w.owner.api.post(`${w.inv}/credit-note`).send({ amount, type: 'write_off' });
const discount = (amount: number) => w.owner.api.post(`${w.inv}/credit-note`).send({ amount, type: 'discount' });

describe('status after a write-off clears the balance', () => {
  it('a write-off of the whole balance reads credited with nothing collected', async () => {
    const res = await writeOff(1000);

    expect(res.status).toBe(200);
    const { row } = await assertInvoiceInvariants(w.invoiceId);
    expect(row.status).toBe('credited');
    expect(row.is_paid).toBe(false);
    expect(row.paid_date).toBeNull();
    expect(res.body.invoice.status).toBe('credited');
    expect(res.body.invoice.isPaid).toBe(false);
    expect(res.body.invoice.remainingBalance).toBe(0);
  });

  it('10 paid and 990 written off reads credited', async () => {
    expect((await pay({ paymentAmount: 10 })).status).toBe(200);

    const res = await writeOff(990);

    expect(res.status).toBe(200);
    const { row } = await assertInvoiceInvariants(w.invoiceId);
    expect(row.status).toBe('credited');
    expect(res.body.invoice.status).toBe('credited');
  });

  it('a discount that clears the balance reads credited', async () => {
    const res = await discount(1000);

    expect(res.status).toBe(200);
    expect((await invoiceRow(w.invoiceId)).status).toBe('credited');
  });

  it('a payment that settles the remainder in cash reads paid', async () => {
    expect((await writeOff(400)).status).toBe(200);

    const res = await pay({ paymentAmount: 600 });

    expect(res.status).toBe(200);
    const { row } = await assertInvoiceInvariants(w.invoiceId);
    expect(row.status).toBe('paid');
    expect(row.is_paid).toBe(true);
    expect(row.paid_date).not.toBeNull();
  });

  it('cash alone covering the total reads paid', async () => {
    expect((await pay({ paymentAmount: 1000 })).status).toBe(200);

    const { row } = await assertInvoiceInvariants(w.invoiceId);
    expect(row.status).toBe('paid');
  });

  it('removing the write-off reopens the invoice', async () => {
    const add = await writeOff(1000);
    const noteId = add.body.invoice.creditNotes[0].id;

    const res = await w.owner.api.delete(`${w.inv}/credit-note?creditNoteId=${noteId}`);

    expect(res.status).toBe(200);
    const { row } = await assertInvoiceInvariants(w.invoiceId);
    expect(row.status).toBe('outstanding');
    expect(row.is_paid).toBe(false);
  });
});

describe('the list rows and counts agree', () => {
  it('a credited invoice counts as credited, collects nothing and is not awaiting payment', async () => {
    expect((await writeOff(1000)).status).toBe(200);
    const base = `/api/lawfirms/${w.firm.id}/billing/invoices/firm`;

    const list = (await w.owner.api.get(base)).body;
    const awaiting = (await w.owner.api.get(`${base}?awaitingOnly=true`)).body;

    expect(list.invoices[0].status).toBe('credited');
    expect(list.invoices[0].amountPaid).toBe(0);
    expect(list.statusCounts.credited).toBe(1);
    expect(list.statusCounts.paid ?? 0).toBe(0);
    expect(awaiting.invoices).toHaveLength(0);
  });
});

describe('surfaces that chase money skip a credited invoice', () => {
  let previousKillSwitch: string | undefined;
  beforeAll(() => {
    previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
    process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
  });
  afterAll(() => {
    if (previousKillSwitch === undefined) delete process.env.DISABLE_ALL_REMINDER_EMAILS;
    else process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
  });
  beforeEach(async () => {
    await testPool.query(
      "update invoices set due_date = current_date - 10, billing_email = 'client@example.test' where id = $1", [w.invoiceId]);
    expect((await writeOff(1000)).status).toBe(200);
  });

  it('a manual reminder says there is nothing outstanding and sends nothing', async () => {
    const res = await w.owner.api.post(`${w.inv}/send-reminder`).send({});

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(false);
    expect(res.body.reason).toMatch(/no outstanding balance|already paid/i);
  });

  it('the workbench counts it as neither overdue nor due soon', async () => {
    await testPool.query("update invoices set due_date = current_date + 3 where id = $1", [w.invoiceId]);

    const res = await w.owner.api.get(`/api/lawfirms/${w.firm.id}/billing/workbench`);

    expect(res.status).toBe(200);
    expect(res.body.collections.overdueCount).toBe(0);
    expect(res.body.collections.dueSoonCount).toBe(0);
  });

  it('a late fee is not applied to it', async () => {
    await testPool.query(
      `update law_firms set settings = coalesce(settings, '{}'::jsonb)
         || '{"billing": {"lateFee": {"enabled": true, "flatAmount": 25, "percent": 0, "graceDays": 0}}}'::jsonb
        where id = $1`, [w.firm.id]);

    const res = await w.owner.api.post(`${w.inv}/late-fee`).send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(Number((await invoiceRow(w.invoiceId)).total_cents)).toBe(100_000);
  });
});
