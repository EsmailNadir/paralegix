/**
 * Payment-plan amounts are whole cents, and a schedule adds up to the
 * balance to the cent.
 *
 * Every plan amount used to accept any positive number and round it later:
 * an installment of 300.005 became 300.01, a down payment of 0.004 became a
 * zero-cent installment, and a replacement schedule of 600.004 + 599.996 was
 * rounded to 600 + 600 BEFORE the sum check, so it passed. A value finer than
 * a cent is now refused at the schema, and every sum check sees exactly what
 * was typed.
 *
 * RED IF: any of setPaymentPlan's installmentAmount or downPaymentAmount,
 * updateInstallment's amount, or replaceSchedule's amounts accepts a sub-cent
 * value; or the existing exact-sum rule loosens.
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
let invoiceId: string;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
const onInvoice = (suffix: string) => `${B()}/${invoiceId}${suffix}`;

const setPlan = (body: Record<string, unknown> = {}) =>
  owner.api.post(onInvoice('/payment-plan')).send({
    installmentAmount: 300, frequencyDays: 30, planStartDate: '2026-04-01', ...body,
  });

async function schedule() {
  const { rows } = await testPool.query(
    `select amount_cents, status, is_down_payment from invoice_expected_payments
      where invoice_id = $1 order by sort_order`, [invoiceId]);
  return rows.map((r: any) => ({ cents: Number(r.amount_cents), status: r.status, down: r.is_down_payment }));
}

async function planEnabled() {
  const { rows } = await testPool.query('select payment_plan_enabled from invoices where id = $1', [invoiceId]);
  return rows[0].payment_plan_enabled;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Plan Client' });
  const created = await owner.api.post(B()).send({
    invoiceName: 'Plan Invoice', invoiceDate: '2026-03-01', dueDate: '2026-04-01',
    totalAmount: 1200, flatFeesAmount: 1200, flatFees: [{ description: 'Fixed fee', amount: 1200 }],
  });
  expect(created.status).toBe(201);
  invoiceId = created.body.invoice.id;
  await drainEvents();
});

describe('setting a plan', () => {
  it.each([
    ['an installment of 300.005', { installmentAmount: 300.005 }],
    ['an installment of 0.005', { installmentAmount: 0.005 }],
    ['a down payment of 100.005', { downPaymentAmount: 100.005, downPaymentAlreadyPaid: false, downPaymentDueDate: '2026-04-01' }],
    ['a down payment of 0.004', { downPaymentAmount: 0.004, downPaymentAlreadyPaid: true }],
  ])('refuses %s and sets no plan', async (_label, body) => {
    const res = await setPlan(body);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/whole cents/i);
    expect(await planEnabled()).toBe(false);
    expect(await schedule()).toEqual([]);
  });

  it('accepts a whole-cent installment and covers the balance exactly', async () => {
    const res = await setPlan({ installmentAmount: 300.01 });

    expect(res.status).toBe(200);
    // 3 x 30,001 + 29,997 = 120,000: the last one takes what is left, to the cent.
    expect((await schedule()).map((r) => r.cents)).toEqual([30_001, 30_001, 30_001, 29_997]);
  });

  it('accepts 33.33, which is 3332.9999999999995 cents in floating point', async () => {
    const res = await setPlan({ installmentAmount: 33.33 });

    expect(res.status).toBe(200);
    const rows = await schedule();
    expect(rows[0].cents).toBe(3_333);
    expect(rows.reduce((s, r) => s + r.cents, 0)).toBe(120_000);
  });

  it('accepts a whole-cent down payment and schedules the rest to the cent', async () => {
    const res = await setPlan({
      installmentAmount: 500, downPaymentAmount: 100.01, downPaymentAlreadyPaid: false, downPaymentDueDate: '2026-04-01',
    });

    expect(res.status).toBe(200);
    expect(await schedule()).toEqual([
      { cents: 10_001, status: 'pending', down: true },
      { cents: 50_000, status: 'pending', down: false },
      { cents: 50_000, status: 'pending', down: false },
      { cents: 9_999, status: 'pending', down: false },
    ]);
  });

  it('still treats a down payment of 0 as no down payment', async () => {
    const res = await setPlan({ downPaymentAmount: 0 });

    expect(res.status).toBe(200);
    expect((await schedule()).map((r) => r.down)).toEqual([false, false, false, false]);
  });
});

describe('changing one installment', () => {
  beforeEach(async () => { expect((await setPlan()).status).toBe(200); });

  it('refuses 300.001 and leaves the schedule as it was', async () => {
    const res = await owner.api.patch(onInvoice('/payment-plan/installment/0')).send({ amount: 300.001 });

    expect(res.status).toBe(400);
    expect((await schedule()).map((r) => r.cents)).toEqual([30_000, 30_000, 30_000, 30_000]);
  });

  it('accepts 250.55 and keeps the schedule summing to the balance', async () => {
    const res = await owner.api.patch(onInvoice('/payment-plan/installment/0')).send({ amount: 250.55 });

    expect(res.status).toBe(200);
    const cents = (await schedule()).map((r) => r.cents);
    expect(cents[0]).toBe(25_055);
    expect(cents.reduce((s, c) => s + c, 0)).toBe(120_000);
  });
});

describe('replacing the schedule', () => {
  beforeEach(async () => { expect((await setPlan()).status).toBe(200); });

  const replace = (amounts: number[]) =>
    owner.api.patch(onInvoice('/payment-plan/schedule')).send({
      installments: amounts.map((amount, i) => ({ dueDate: `2026-0${4 + i}-01`, amount })),
    });

  it('refuses sub-cent amounts that only add up after rounding', async () => {
    const res = await replace([600.004, 599.996]);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/whole cents/i);
    expect((await schedule()).map((r) => r.cents)).toEqual([30_000, 30_000, 30_000, 30_000]);
  });

  it('refuses a schedule one cent over the balance (the existing exact-sum rule)', async () => {
    const res = await replace([600, 600.01]);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/add up to \$1200\.01/);
    expect((await schedule()).map((r) => r.cents)).toEqual([30_000, 30_000, 30_000, 30_000]);
  });

  it('accepts whole-cent amounts that sum to the balance exactly', async () => {
    const res = await replace([600.01, 599.99]);

    expect(res.status).toBe(200);
    expect((await schedule()).map((r) => r.cents)).toEqual([60_001, 59_999]);
  });
});
