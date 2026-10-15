/**
 * Work released by a voided invoice counts against a retainer period: with a 1h
 * allowance and 3h released, the period consumes 1h, bills 2h of overage, and the
 * draft carries a 2h time line ($400) beside the $500 fee.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
const P = () => `/api/lawfirms/${firm.id}/billing/plans`;
const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const INV = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Void Usage', email: 'vu@example.test' });
  await drainEvents();
});

it('counts hours released by a voided invoice against the allowance and bills the overage', async () => {
  const res = await owner.api.post(T()).send({
    clientId: client.id, userId: owner.uid, hours: 3, date: '2026-03-10', hourlyRate: 200, description: 'Work',
  });
  const id = res.body.timeEntry.id as string;
  const inv = await owner.api.post(INV()).send({
    invoiceName: 'Manual', invoiceDate: '2026-03-15',
    timeEntries: [{ id, hours: 3, rate: 200, amount: 600 }], totalAmount: 600,
  });
  expect(inv.status).toBe(201);
  expect((await owner.api.post(`${INV()}/${inv.body.invoice.id}/void`)).status).toBe(200);
  await drainEvents();
  const unbilled = await owner.api.get(`${INV()}/unbilled-summary`);
  expect(unbilled.body.unbilledTimeEntries.map((e: any) => e.id)).toContain(id);

  const plan = await owner.api.post(P()).send({
    contextType: 'client', entityId: client.id, name: 'Retainer', intervalUnit: 'month',
    startDate: '2026-03-01', amount: 500, includedHours: 1,
  });
  const period = plan.body.plan.periods.find((p: any) => p.id === '2026-03-01');
  expect({ consumed: period.consumedHours, overage: period.overageHours }).toEqual({ consumed: 1, overage: 2 });

  const draft = await owner.api.post(`${P()}/${plan.body.plan.id}/periods/2026-03-01/create-draft`).send({});
  const lines = await testPool.query(
    `select kind, quantity::text as qty, amount_cents::int as cents from invoice_line_items where invoice_id = $1 order by kind`,
    [draft.body.invoice.id]);
  expect(lines.rows).toEqual([
    { kind: 'flat_fee', qty: null, cents: 50_000 },
    { kind: 'time_entry', qty: '2', cents: 40_000 },
  ]);
});
