/**
 * A payment plan holds at most MAX_PLAN_INSTALLMENTS (120) schedule rows.
 *
 * Whole cents bounds the amount but not the count: an installment of 0.01 on
 * a 10,000.00 balance would write 1,000,000 invoice_expected_payments rows
 * inside the invoice row lock. The count is worked out in integer cents
 * before any row is built, and an explicit schedule is bounded by its length.
 *
 * RED IF: setPaymentPlan builds a schedule with more than 120 rows (a down
 * payment counts as one), replaceSchedule accepts more than 120 rows in total
 * (kept paid rows included), a refusal writes any row or flips the plan on,
 * or the refusal has to generate the schedule before it can refuse.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

let seq = 0;
const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

async function newInvoice(total: number): Promise<string> {
  const created = await owner.api.post(B()).send({
    invoiceName: `Cap Invoice ${++seq}`, invoiceDate: '2026-03-01', dueDate: '2026-04-01',
    totalAmount: total, flatFeesAmount: total, flatFees: [{ description: 'Fixed fee', amount: total }],
  });
  expect(created.status).toBe(201);
  await drainEvents();
  return created.body.invoice.id;
}

const setPlan = (invoiceId: string, body: Record<string, unknown>) =>
  owner.api.post(`${B()}/${invoiceId}/payment-plan`).send({
    installmentAmount: 10, frequencyDays: 30, planStartDate: '2026-04-01', ...body,
  });

const replace = (invoiceId: string, installments: Array<{ dueDate: string; amount: number }>) =>
  owner.api.patch(`${B()}/${invoiceId}/payment-plan/schedule`).send({ installments });

async function rows(invoiceId: string) {
  const { rows: r } = await testPool.query(
    'select amount_cents from invoice_expected_payments where invoice_id = $1 order by sort_order', [invoiceId]);
  return r.map((x: any) => Number(x.amount_cents));
}

async function planEnabled(invoiceId: string) {
  const { rows: r } = await testPool.query('select payment_plan_enabled from invoices where id = $1', [invoiceId]);
  return r[0].payment_plan_enabled;
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

// Distinct monthly due dates so a long schedule has no collisions.
const monthly = (n: number, amount: number) => Array.from({ length: n }, (_, i) => ({
  dueDate: `${2026 + Math.floor((3 + i) / 12)}-${String(((3 + i) % 12) + 1).padStart(2, '0')}-01`,
  amount,
}));

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Cap Client' });
});

describe('setting a plan', () => {
  it('accepts exactly 120 installments and they sum to the balance in cents', async () => {
    const id = await newInvoice(1200);

    const res = await setPlan(id, { installmentAmount: 10 });

    expect(res.status).toBe(200);
    const r = await rows(id);
    expect(r).toHaveLength(120);
    expect(sum(r)).toBe(120_000);
  });

  it('accepts 120 installments when the last one is a short remainder', async () => {
    const id = await newInvoice(1195.5);

    const res = await setPlan(id, { installmentAmount: 10 });

    expect(res.status).toBe(200);
    const r = await rows(id);
    expect(r).toHaveLength(120);
    expect(r[119]).toBe(550);
    expect(sum(r)).toBe(119_550);
  });

  it('refuses 121 installments, names the limit and writes nothing', async () => {
    const id = await newInvoice(1210);

    const res = await setPlan(id, { installmentAmount: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/120/);
    expect(res.body.error).toMatch(/larger installment/i);
    expect(await rows(id)).toEqual([]);
    expect(await planEnabled(id)).toBe(false);
  });

  it('refuses 121 installments when only a one-cent remainder spills over', async () => {
    const id = await newInvoice(1200.01);

    const res = await setPlan(id, { installmentAmount: 10 });

    expect(res.status).toBe(400);
    expect(await rows(id)).toEqual([]);
  });

  it('refuses 0.01 on 5.00 (500 installments) and writes nothing', async () => {
    const id = await newInvoice(5);

    const res = await setPlan(id, { installmentAmount: 0.01 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/120/);
    expect(await rows(id)).toEqual([]);
    expect(await planEnabled(id)).toBe(false);
  });

  it('refuses 0.01 on 10,000.00 quickly instead of generating a million rows', async () => {
    const id = await newInvoice(10_000);

    const started = Date.now();
    const res = await setPlan(id, { installmentAmount: 0.01 });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(400);
    expect(elapsed).toBeLessThan(3_000);
    expect(await rows(id)).toEqual([]);
    expect(await planEnabled(id)).toBe(false);
  });

  it('counts the down payment as one of the 120', async () => {
    const ok = await newInvoice(1200);
    const okRes = await setPlan(ok, {
      installmentAmount: 10, downPaymentAmount: 10, downPaymentAlreadyPaid: false, downPaymentDueDate: '2026-04-01',
    });
    expect(okRes.status).toBe(200);
    expect(await rows(ok)).toHaveLength(120);

    const over = await newInvoice(1210);
    const overRes = await setPlan(over, {
      installmentAmount: 10, downPaymentAmount: 10, downPaymentAlreadyPaid: false, downPaymentDueDate: '2026-04-01',
    });
    expect(overRes.status).toBe(400);
    expect(await rows(over)).toEqual([]);
  });

  it('still sets an ordinary 12-month plan', async () => {
    const id = await newInvoice(1200);

    const res = await setPlan(id, { installmentAmount: 100 });

    expect(res.status).toBe(200);
    expect(await rows(id)).toEqual(Array(12).fill(10_000));
  });
});

describe('replacing the schedule', () => {
  it('accepts 120 entries that sum to the balance', async () => {
    const id = await newInvoice(1200);
    expect((await setPlan(id, { installmentAmount: 100 })).status).toBe(200);

    const res = await replace(id, monthly(120, 10));

    expect(res.status).toBe(200);
    const r = await rows(id);
    expect(r).toHaveLength(120);
    expect(sum(r)).toBe(120_000);
  });

  it('refuses a 121-entry array and leaves the schedule as it was', async () => {
    const id = await newInvoice(1210);
    expect((await setPlan(id, { installmentAmount: 121 })).status).toBe(200);
    const before = await rows(id);

    const res = await replace(id, monthly(121, 10));

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/120/);
    expect(await rows(id)).toEqual(before);
  });

  it('counts the paid installments it keeps toward the 120', async () => {
    const id = await newInvoice(600);
    expect((await setPlan(id, { installmentAmount: 100 })).status).toBe(200);
    const paid = await owner.api.put(`${B()}/${id}/payment`).send({
      isPaid: true, paymentAmount: 100, paidDate: '2026-04-01', installmentIndex: 0,
    });
    expect(paid.status).toBe(200);
    const before = await rows(id);

    // 500.00 left to collect, split so the sum rule is satisfied: the only
    // thing wrong is that 1 paid row plus 120 new ones is 121.
    const entries = monthly(120, 4);
    entries[119].amount = 24;
    const res = await replace(id, entries);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/120/);
    expect(res.body.error).not.toMatch(/add up/);
    expect(await rows(id)).toEqual(before);
  });
});

describe('creating an invoice', () => {
  it('has no plan to cap: a paymentPlan in the create body writes no schedule', async () => {
    const created = await owner.api.post(B()).send({
      invoiceName: 'No Plan Here', invoiceDate: '2026-03-01', dueDate: '2026-04-01',
      totalAmount: 5, flatFeesAmount: 5, flatFees: [{ description: 'Fixed fee', amount: 5 }],
      paymentPlan: { enabled: true, installmentAmount: 0.01, frequencyDays: 30, planStartDate: '2026-04-01' },
    });

    expect(created.status).toBe(201);
    const id = created.body.invoice.id;
    expect(await rows(id)).toEqual([]);
    expect(await planEnabled(id)).toBe(false);
  });
});
