/**
 * What `POST /billing/invoices` accepts as a source.
 *
 * An invoice line names the work it bills by `id`. The create path refuses a
 * source that another live invoice holds, non-billable work of any kind, and ids
 * that name no work in the invoice's own context.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';
import { seedMatter } from '../../support/matters';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const E = () => `/api/lawfirms/${firm.id}/billing/expenses`;
const INV = () => `/api/lawfirms/${firm.id}/billing/invoices`;

const lineCount = async (kind: string) => Number((await testPool.query(
  `select count(*)::int as n from invoice_line_items where law_firm_id = $1 and kind = $2`,
  [firm.id, kind])).rows[0].n);
const invoiceCount = async () => Number((await testPool.query(
  'select count(*)::int as n from invoices where law_firm_id = $1', [firm.id])).rows[0].n);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Guard Client', email: 'guard@example.test' });
  await drainEvents();
});

describe('non-billable work is refused with a 400, not dropped', () => {
  it('refuses a non-billable time entry and writes no invoice', async () => {
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

  it('refuses a non-billable expense and writes no invoice', async () => {
    const created = await owner.api.post(E()).send({
      clientId: client.id, description: 'Personal lunch', amount: 42, date: '2026-03-10', billable: false,
    });
    expect(created.status).toBe(201);
    expect(created.body.expense.billable).toBe(false);

    const res = await owner.api.post(`${INV()}/client/${client.id}`).send({
      invoiceName: 'Not billable', invoiceDate: '2026-03-15',
      expenses: [{ id: created.body.expenseId, description: 'Personal lunch', amount: 42 }],
      totalAmount: 42,
    });

    expect(res.status).toBe(400);
    expect(await lineCount('expense')).toBe(0);
    expect(await invoiceCount()).toBe(0);
  });
});

describe('a line must name work in the invoice context', () => {
  it('refuses a time line that names an entry logged on a different matter', async () => {
    const matterA = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
    const matterB = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
    const onB = await owner.api.post(T()).send({
      matterId: matterB, userId: owner.uid, hours: 2, date: '2026-03-10', hourlyRate: 100,
    });
    expect(onB.status).toBe(201);

    const res = await owner.api.post(INV()).send({
      matterId: matterA, invoiceName: 'Wrong matter', invoiceDate: '2026-03-15',
      timeEntries: [{ id: onB.body.timeEntry.id, hours: 2, rate: 100, amount: 200 }],
      totalAmount: 200,
    });

    expect(res.status).toBe(400);
    expect(await lineCount('time_entry')).toBe(0);
  });
});

describe('one entry is billed once across contexts', () => {
  it('refuses an entry on another matter invoice, leaving it billable on its own matter exactly once', async () => {
    const matterA = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
    const matterB = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
    const onB = await owner.api.post(T()).send({
      matterId: matterB, userId: owner.uid, hours: 2, date: '2026-03-10', hourlyRate: 100,
    });
    const id = onB.body.timeEntry.id as string;
    const line = [{ id, hours: 2, rate: 100, amount: 200 }];

    const wrong = await owner.api.post(INV()).send({
      matterId: matterA, invoiceName: 'First', invoiceDate: '2026-03-15', timeEntries: line, totalAmount: 200,
    });
    const own = await owner.api.post(INV()).send({
      matterId: matterB, invoiceName: 'Second', invoiceDate: '2026-03-15', timeEntries: line, totalAmount: 200,
    });
    const again = await owner.api.post(INV()).send({
      matterId: matterB, invoiceName: 'Third', invoiceDate: '2026-03-15', timeEntries: line, totalAmount: 200,
    });

    expect({ wrong: wrong.status, own: own.status, again: again.status }).toEqual({ wrong: 400, own: 201, again: 400 });
    const { rows } = await testPool.query(
      `select count(*)::int as n from invoice_line_items li join invoices i on i.id = li.invoice_id
        where li.source_id = $1 and i.status <> 'voided'`, [id]);
    expect(rows[0].n).toBe(1);
  });
});
