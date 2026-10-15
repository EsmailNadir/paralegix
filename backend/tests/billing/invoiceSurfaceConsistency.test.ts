/**
 * B06.1 row 2: "Invoice components, tax, discounts, adjustments, credits,
 * payments, balance, and status agree across detail, list, workbench,
 * reports, portal, and exports where each is exposed."
 *
 * Every surface below is built by an INDEPENDENT serializer over the same
 * underlying invoice row:
 *   - GET .../invoices/client/:clientId       -> invoices.service.formatInvoice
 *   - GET .../invoices/firm                   -> firmBilling.service.mapInvoiceRecord
 *   - GET .../invoices/client/:id/:id/export/ledes -> ledesExport.service.generateLedesExport
 *
 * `formatInvoice` and `mapInvoiceRecord` already share a canonical
 * `computeInvoiceDerived` helper specifically because they used to drift; the
 * export does NOT go through either one, and until this file existed nothing
 * in the suite ever built one invoice with a non-round total, a flat fee, a
 * discount, and a partial payment and then compared what the three surfaces
 * say about it.
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

const base = () => `/api/lawfirms/${firm.id}/billing/invoices`;
const clientBase = () => `${base()}/client/${client.id}`;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Surface Check Client', email: 'surface@example.test' });
  await drainEvents();
});

/**
 * Create an invoice carrying a time entry AND a flat fee (so the pre-fix LEDES
 * bug -- adding `flatFeesAmount` on top of `totalAmount`, which already
 * includes it -- would actually change the exported number), a firm-level tax
 * rate, then apply a discount credit note and a partial payment. Every amount
 * is a non-round cent value so any drift/doubling shows up unmistakably.
 */
async function createMixedInvoice() {
  // Subtotal: 850.30 (time) + 149.71 (flat fee) = 1000.01, chosen so tax on it
  // produces a non-round result too (8.875% of $1000.01 = $88.75 to the cent).
  const createRes = await owner.api.post(clientBase()).send({
    invoiceName: 'Mixed surface-consistency invoice',
    invoiceDate: '2026-03-01',
    dueDate: '2026-03-31',
    totalAmount: 1000.01,
    flatFeesAmount: 149.71,
    taxRate: 8.875,
    timeEntries: [
      { date: '2026-03-01', hours: 1, rate: 850.30, amount: 850.30, name: 'Drafting' },
    ],
    flatFees: [
      { date: '2026-03-01', amount: 149.71, description: 'Filing fee' },
    ],
  });
  expect(createRes.status).toBe(201);
  const invoiceId = createRes.body.invoiceId ?? createRes.body.invoice?.id;
  expect(invoiceId).toBeTruthy();
  await drainEvents();

  // Discount credit note: knocks $75.03 off what's owed, no cash received.
  const creditRes = await owner.api.post(`${clientBase()}/${invoiceId}/credit-note`)
    .send({ amount: 75.03, type: 'discount', description: 'Loyalty discount' });
  expect(creditRes.status).toBeGreaterThanOrEqual(200);
  expect(creditRes.status).toBeLessThan(300);
  await drainEvents();

  // Partial payment: less than the remaining balance, so the invoice lands on
  // 'partially_paid' rather than settling, and remainingBalance is a nonzero,
  // non-round figure every surface has to agree on independently.
  const paymentRes = await owner.api.put(`${clientBase()}/${invoiceId}/payment`)
    .send({ paymentAmount: 300.11, paidDate: '2026-03-15' });
  expect(paymentRes.status).toBe(200);
  await drainEvents();

  return invoiceId as string;
}

describe('invoice state agrees across detail, firm list, and LEDES export', () => {
  it('reports the identical totalAmount, remainingBalance and status on the detail and firm-list surfaces', async () => {
    const invoiceId = await createMixedInvoice();

    const detailRes = await owner.api.get(clientBase());
    expect(detailRes.status).toBe(200);
    const detail = detailRes.body.invoices.find((inv: any) => inv.id === invoiceId);
    expect(detail).toBeTruthy();

    const listRes = await owner.api.get(`${base()}/firm`);
    expect(listRes.status).toBe(200);
    const listed = listRes.body.invoices.find((inv: any) => inv.id === invoiceId);
    expect(listed).toBeTruthy();

    // Ground truth independent of either serializer: the persisted row itself.
    const { rows } = await testPool.query(
      `select total_cents, amount_paid_cents, balance_due_cents, status
         from invoices where id = $1`,
      [invoiceId],
    );
    const stored = rows[0];
    // Subtotal 850.30 + 149.71 = 1000.01 (100_001 cents); tax is 8.875% of
    // that, rounded: round(100_001 * 0.08875) = 8_875 cents ($88.75). Total =
    // 108_876 cents ($1,088.76). Independent arithmetic, not the app's own
    // tax-rounding code.
    expect(Number(stored.total_cents)).toBe(108_876);
    expect(Number(stored.balance_due_cents)).toBeGreaterThan(0);

    // Detail and list must both match the stored row, in cents, not just each
    // other -- two serializers can independently agree on the SAME wrong number.
    expect(Math.round(detail.totalAmount * 100)).toBe(Number(stored.total_cents));
    expect(Math.round(listed.totalAmount * 100)).toBe(Number(stored.total_cents));
    expect(Math.round(detail.remainingBalance * 100)).toBe(Number(stored.balance_due_cents));
    expect(Math.round(listed.remainingBalance * 100)).toBe(Number(stored.balance_due_cents));
    expect(detail.status).toBe(stored.status);
    expect(listed.status).toBe(stored.status);
    expect(detail.status).toBe('partially_paid');

    // Same figures presented the same way on both surfaces, not just both
    // agreeing with the DB by coincidence of independent rounding.
    expect(detail.totalAmount).toBe(listed.totalAmount);
    expect(detail.remainingBalance).toBe(listed.remainingBalance);
    expect(detail.amountPaid).toBe(listed.amountPaid);
    expect(detail.totalWrittenOff).toBe(listed.totalWrittenOff);
  });

  it('LEDES export INVOICE_TOTAL matches the detail totalAmount, not totalAmount plus flat fees again', async () => {
    const invoiceId = await createMixedInvoice();

    const detailRes = await owner.api.get(clientBase());
    const detail = detailRes.body.invoices.find((inv: any) => inv.id === invoiceId);
    expect(detail).toBeTruthy();
    expect(detail.flatFeesAmount).toBe(149.71);

    const exportRes = await owner.api.get(`${clientBase()}/${invoiceId}/export/ledes`);
    expect(exportRes.status).toBe(200);

    const lines = String(exportRes.text).split('\r\n');
    // Header + columns + at least one data row.
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const dataRow = lines[2].replace(/\[\]$/, '').split('|');

    // The bug: naively adding flatFeesAmount on top of totalAmount (which
    // already folds flat fees in) would report detail.totalAmount + 149.71
    // here instead of detail.totalAmount. Compared as the exact exported text.
    expect(dataRow[4]).toBe(detail.totalAmount.toFixed(2)); // INVOICE_TOTAL
  });
});

describe('a voided invoice is cancelled on every surface', () => {
  /**
   * One live invoice ($400, $100 paid, so $300 owed) and one voided invoice
   * ($1,000) in the same firm. Every outstanding figure the firm can read must
   * be the live $300, in cents, computed independently by each surface.
   * RED IF any surface still counts the voided invoice: it moves by 100_000.
   */
  const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  async function issue(name: string, dollars: number) {
    const res = await owner.api.post(clientBase()).send({
      invoiceName: name, invoiceDate: dayOffset(0), dueDate: dayOffset(10),
      totalAmount: dollars, flatFeesAmount: dollars, flatFees: [{ description: name, amount: dollars }],
    });
    expect(res.status).toBe(201);
    return res.body.invoice.id as string;
  }

  /** Outstanding cents as each surface reports it. */
  async function outstandingEverywhere() {
    const cents = (dollars: number) => Math.round(dollars * 100);
    const workbench = (await owner.api.get(`/api/lawfirms/${firm.id}/billing/workbench`)).body;
    const awaiting = (await owner.api.get(`${base()}/firm?awaitingOnly=true`)).body;
    const scoped = (await owner.api.get(`${base()}/firm?clientScope=${client.id}`)).body;
    const byClient = (await owner.api.get(`/api/lawfirms/${firm.id}/billing/reports/by-client`)).body;
    const analytics = (await owner.api.get(`/api/lawfirms/${firm.id}/billing/analytics/billing-summary`)).body;
    const dashboard = (await owner.api.get(`/api/lawfirms/${firm.id}/dashboard-summary`)).body;
    const reportRow = byClient.rows.filter((r: any) => r.name === 'Surface Check Client');
    expect(reportRow).toHaveLength(1);
    return {
      workbenchAwaiting: cents(workbench.summary.awaitingAmount),
      dueTiles: cents(awaiting.dueGroupTotals.all.amount),
      clientSummary: cents(scoped.summary.totalOutstanding),
      report: cents(reportRow[0].totalOutstanding),
      analyticsOutstanding: cents(analytics.totalOutstanding),
      analyticsAwaiting: cents(analytics.awaitingAmount),
      dashboard: dashboard.stats.outstandingArCents,
    };
  }

  const every = (value: number) => ({
    workbenchAwaiting: value, dueTiles: value, clientSummary: value, report: value,
    analyticsOutstanding: value, analyticsAwaiting: value, dashboard: value,
  });

  it('every outstanding figure is the live invoice alone, and both serializers say voided', async () => {
    const liveId = await issue('Live', 400);
    expect((await owner.api.put(`${clientBase()}/${liveId}/payment`).send({ paymentAmount: 100 })).status).toBe(200);
    const voidedId = await issue('Cancelled', 1000);
    await drainEvents();

    // Control: every surface counted the second invoice while it was live.
    expect(await outstandingEverywhere()).toEqual(every(130_000));

    expect((await owner.api.post(`${clientBase()}/${voidedId}/void`)).status).toBe(200);
    await drainEvents();

    expect(await outstandingEverywhere()).toEqual(every(30_000));

    const detail = (await owner.api.get(clientBase())).body.invoices.find((i: any) => i.id === voidedId);
    const listed = (await owner.api.get(`${base()}/firm`)).body.invoices.find((i: any) => i.id === voidedId);
    expect(detail.status).toBe('voided');
    expect(listed.status).toBe('voided');
  });
});
