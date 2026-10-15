/**
 * The firm's billing workbench and invoice list after an invoice is voided.
 *
 * A voided invoice keeps its whole balance on paper forever, because voiding
 * writes only the status. Every collections figure here used to read the
 * balance, so a cancelled bill went on being "awaiting payment", "due soon",
 * "outstanding" and first in the work-to-do order.
 *
 * RED IF: invoiceStatusKey stops returning 'voided' (the money filters and the
 * awaiting totals pick it back up), the workbench's due-soon bucket stops
 * excluding it, or the paymentPriority order stops treating it as settled.
 */
import {
  createFirm,
  createPersonClient,
  ownerOf,
  drainEvents,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices`;
const onInvoice = (id: string, suffix = '') => `${B()}/client/${client.id}/${id}${suffix}`;
/** A calendar day relative to now, far enough from the edges that the viewer's zone cannot move it across a bucket. */
const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function issue(name: string, dollars: number, dueDate: string) {
  const res = await owner.api.post(`${B()}/client/${client.id}`).send({
    invoiceName: name,
    invoiceDate: dayOffset(-40),
    dueDate,
    totalAmount: dollars,
    flatFeesAmount: dollars,
    flatFees: [{ description: name, amount: dollars }],
  });
  expect(res.status).toBe(201);
  await drainEvents();
  return res.body.invoice.id as string;
}

async function voidIt(id: string) {
  const res = await owner.api.post(onInvoice(id, '/void'));
  expect(res.status).toBe(200);
  expect(res.body.invoice.status).toBe('voided');
}

const workbench = async () => {
  const res = await owner.api.get(`/api/lawfirms/${firm.id}/billing/workbench`);
  expect(res.status).toBe(200);
  return res.body;
};
const firmList = async (query = '') => {
  const res = await owner.api.get(`${B()}/firm${query}`);
  expect(res.status).toBe(200);
  return res.body;
};
const listIds = (body: any) => body.invoices.map((i: any) => i.id);

let liveId: string;
let voidedSoonId: string;
let voidedLateId: string;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Workbench Client', email: 'wb@example.test' });

  // Live: $400 total, $100 paid, $50 written off, so $250 still owed and the
  // status is partially_paid. Due in 3 days.
  liveId = await issue('Live bill', 400, dayOffset(3));
  expect((await owner.api.put(onInvoice(liveId, '/payment')).send({ paymentAmount: 100 })).status).toBe(200);
  expect((await owner.api.post(onInvoice(liveId, '/credit-note'))
    .send({ amount: 50, type: 'write_off', description: 'Goodwill' })).status).toBe(200);

  // Voided, due in 3 days: the trap for the due-soon bucket and the 'outstanding' chip.
  voidedSoonId = await issue('Cancelled soon', 1000, dayOffset(3));
  // Voided, a month late: the trap for the overdue filter.
  voidedLateId = await issue('Cancelled late', 700, dayOffset(-30));
  await drainEvents();
});

describe('before the void, the same invoices are counted', () => {
  it('reads all three as awaiting payment and two as due soon', async () => {
    // The positive control. Without it, every absence below could pass because
    // the seed never reached these figures.
    const body = await workbench();
    expect(body.summary.awaitingCount).toBe(3);
    expect(body.summary.awaitingAmount).toBe(1950);
    expect(body.collections.dueSoonCount).toBe(2);
  });
});

describe('after the void', () => {
  beforeEach(async () => {
    await voidIt(voidedSoonId);
    await voidIt(voidedLateId);
  });

  it('awaits payment only on the live invoice, in cents', async () => {
    const body = await workbench();
    expect(body.summary.awaitingCount).toBe(1);
    expect(body.summary.awaitingAmount).toBe(250);
    expect(body.summary.totalCollected).toBe(100);
    // The tab badge still counts every row the list shows, voided rows included.
    expect(body.summary.totalInvoices).toBe(3);
    expect(body.collections.dueSoonCount).toBe(1);
    expect(body.collections.overdueCount).toBe(0);
  });

  it('keeps voided invoices out of the money filters', async () => {
    expect(listIds(await firmList('?status=unpaid'))).toEqual([liveId]);
    expect(listIds(await firmList('?status=outstanding'))).toEqual([]);
    expect(listIds(await firmList('?status=overdue'))).toEqual([]);
    expect(listIds(await firmList('?status=due_soon'))).toEqual([liveId]);
  });

  it('lists them under their own filter and chip', async () => {
    expect(listIds(await firmList('?status=voided')).sort()).toEqual([voidedSoonId, voidedLateId].sort());

    const { statusCounts } = await firmList();
    expect(statusCounts).toMatchObject({ all: 3, voided: 2, partially_paid: 1, overdue: 0 });
    expect(statusCounts).not.toHaveProperty('outstanding');
  });

  it('sums only the live balance into the upcoming-payment tiles', async () => {
    const body = await firmList('?awaitingOnly=true');
    expect(listIds(body)).toEqual([liveId]);
    expect(body.dueGroupTotals.all).toEqual({ count: 1, amount: 250 });
    expect(body.dueGroupTotals.this_week).toEqual({ count: 1, amount: 250 });
    expect(body.dueGroupTotals.overdue).toEqual({ count: 0, amount: 0 });
  });

  it('orders voided invoices after the one still owed', async () => {
    // Before the fix all three were "not done", so the month-late voided bill
    // sorted first by due day.
    expect(listIds(await firmList('?sort=paymentPriority:asc'))).toEqual([liveId, voidedLateId, voidedSoonId]);
  });

  it('summarizes the client relationship from the live invoice alone, net of its write-off', async () => {
    const body = await firmList(`?clientScope=${client.id}`);
    // $400 billed, $100 paid, $50 written off. The voided $1,700 is not the client's debt.
    expect(body.summary).toEqual({ ownedCount: 1, totalBilled: 400, totalPaid: 100, totalOutstanding: 250 });
  });
});
