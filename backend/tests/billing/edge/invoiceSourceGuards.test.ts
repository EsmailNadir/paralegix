/**
 * What `POST /billing/invoices` accepts as a source, and what the unbilled
 * summary offers.
 *
 * RED IF: a non-billable time entry reaches an invoice or stops being a clear
 * 400, or the unbilled summary offers written-off time or expenses.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const E = () => `/api/lawfirms/${firm.id}/billing/expenses`;
const INV = () => `/api/lawfirms/${firm.id}/billing/invoices`;

const invoiceCount = async () => Number((await testPool.query(
  'select count(*)::int as n from invoices where law_firm_id = $1', [firm.id])).rows[0].n);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Guard Client', email: 'guard@example.test' });
  await drainEvents();
});

describe('non-billable work', () => {
  it('is refused on an invoice with a clear 400, not dropped, and writes no invoice', async () => {
    const created = await owner.api.post(T()).send({
      clientId: client.id, userId: owner.uid, hours: 1, date: '2026-03-10', hourlyRate: 100, billable: false,
    });
    expect(created.status).toBe(201);

    const res = await owner.api.post(`${INV()}/client/${client.id}`).send({
      invoiceName: 'Written off', invoiceDate: '2026-03-15',
      timeEntries: [{ id: created.body.timeEntry.id, hours: 1, rate: 100, amount: 100 }],
      totalAmount: 100,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-billable/i);
    expect(await invoiceCount()).toBe(0);
  });

  it('is left out of the unbilled summary while billable work beside it is offered', async () => {
    const billable = await owner.api.post(T()).send({
      clientId: client.id, userId: owner.uid, hours: 1, date: '2026-03-10', hourlyRate: 100,
    });
    const writtenOff = await owner.api.post(T()).send({
      clientId: client.id, userId: owner.uid, hours: 2, date: '2026-03-10', hourlyRate: 100, billable: false,
    });
    const billableExpense = await owner.api.post(E()).send({
      clientId: client.id, description: 'Filing fee', amount: 30, date: '2026-03-10',
    });
    const writtenOffExpense = await owner.api.post(E()).send({
      clientId: client.id, description: 'Personal lunch', amount: 42, date: '2026-03-10', billable: false,
    });

    const res = await owner.api.get(`${INV()}/client/${client.id}/unbilled-summary`);

    expect(res.status).toBe(200);
    const timeIds = res.body.unbilledTimeEntries.map((e: any) => e.id);
    expect(timeIds).toEqual([billable.body.timeEntry.id]);
    expect(timeIds).not.toContain(writtenOff.body.timeEntry.id);
    const expenseIds = res.body.unbilledExpenses.map((e: any) => e.id);
    expect(expenseIds).toEqual([billableExpense.body.expenseId]);
    expect(expenseIds).not.toContain(writtenOffExpense.body.expenseId);
    expect(res.body.totalUnbilledHours).toBe(1);
    expect(res.body.totalUnbilledExpenses).toBe(30);
  });
});
