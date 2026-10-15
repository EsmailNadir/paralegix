/**
 * Firm headline money after an invoice is voided: the billing summary
 * (analytics) and the firm dashboard.
 *
 * RED IF: getBillingSummary sums a voided invoice into billed, collected,
 * outstanding, awaiting or this month's revenue, or the dashboard's
 * outstandingArCents sums its balance_due_cents.
 */
import {
  createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type ClientRecord, type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let liveId: string;
let voidedId: string;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function issue(name: string, dollars: number, dueDate: string) {
  const res = await owner.api.post(B()).send({
    invoiceName: name, invoiceDate: dayOffset(0), dueDate,
    totalAmount: dollars, flatFeesAmount: dollars, flatFees: [{ description: name, amount: dollars }],
  });
  expect(res.status).toBe(201);
  return res.body.invoice.id as string;
}

const analytics = async () => {
  const res = await owner.api.get(`/api/lawfirms/${firm.id}/billing/analytics/billing-summary`);
  expect(res.status).toBe(200);
  return res.body;
};
const dashboard = async () => {
  const res = await owner.api.get(`/api/lawfirms/${firm.id}/dashboard-summary`);
  expect(res.status).toBe(200);
  return res.body.stats;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Headline Client', email: 'headline@example.test' });
  liveId = await issue('Live', 400, dayOffset(10));
  expect((await owner.api.put(`${B()}/${liveId}/payment`).send({ paymentAmount: 100 })).status).toBe(200);
  // Overdue too, so the existing overdue exclusion is exercised alongside the new ones.
  voidedId = await issue('Cancelled', 1000, dayOffset(-30));
  await drainEvents();
});

it('counts the invoice before it is voided (control)', async () => {
  expect((await analytics()).totalOutstanding).toBe(1300);
  expect((await dashboard()).outstandingArCents).toBe(130_000);
});

describe('after the void', () => {
  beforeEach(async () => {
    expect((await owner.api.post(`${B()}/${voidedId}/void`)).status).toBe(200);
  });

  it('leaves it out of every billing-summary money figure', async () => {
    expect(await analytics()).toMatchObject({
      totalBilled: 400,
      totalCollected: 100,
      totalOutstanding: 300,
      totalRevenueThisMonth: 400,
      awaitingCount: 1,
      awaitingAmount: 300,
      overdueCount: 0,
      overdueAmount: 0,
      // Still a row in the invoice list the badge counts.
      totalInvoices: 2,
    });
  });

  it('leaves it out of the dashboard receivable, in cents', async () => {
    const stats = await dashboard();
    expect(stats.outstandingArCents).toBe(30_000);
    expect(stats.overdueInvoiceCount).toBe(0);
  });
});
