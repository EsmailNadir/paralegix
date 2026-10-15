/**
 * Every field of a time entry on a live invoice, through the update route: the
 * ones the invoice line was built from are refused (403, row unchanged), the
 * descriptive ones are not, delete is refused, and a void gives all of it back.
 *
 * RED IF: any frozen field changes on a billed entry, any descriptive field is
 * refused, the delete goes through, or a voided invoice keeps the entry frozen.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';
import { seedMatter } from '../../support/matters';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let matterId: string;
let chargeCodeId: string;
let entryId: string;
let invoiceId: string;

const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const INV = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
const edit = (body: Record<string, unknown>) => owner.api.put(`${T()}/client/${client.id}/${entryId}`).send(body);
const stored = async () => (await testPool.query(
  `select hours::text as hours, rate_cents::int as rate, activity_date::text as day, billable, billing_code_id,
          matter_id, client_id, matter_client_ids, description, utbms_task_code, resolved_rate_cents::int as resolved
     from activities where id = $1`, [entryId])).rows[0];

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Freeze Client', email: 'freeze@example.test' });
  matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
  const code = await owner.api.post(`/api/lawfirms/${firm.id}/billing/charge-codes`)
    .send({ code: 'FREEZE1', name: 'Freeze', defaultRate: 500 });
  chargeCodeId = code.body.chargeCodeId;
  const created = await owner.api.post(T()).send({
    clientId: client.id, userId: owner.uid, hours: 1.5, date: '2026-03-10', hourlyRate: 250, description: 'Original',
  });
  entryId = created.body.timeEntry.id;
  const billed = await owner.api.post(INV()).send({
    invoiceName: 'Live', invoiceDate: '2026-03-15',
    timeEntries: [{ id: entryId, hours: 1.5, rate: 250, amount: 375 }], totalAmount: 375,
  });
  expect(billed.status).toBe(201);
  invoiceId = billed.body.invoice.id;
  await drainEvents();
});

const FROZEN: Array<[string, Record<string, unknown>]> = [
  ['hours', { hours: 2 }],
  ['hourlyRate', { hourlyRate: 300 }],
  ['date', { date: '2026-03-11' }],
  ['chargeCodeId', { chargeCodeId: null }],
  ['billable', { billable: false }],
  ['matterClientIds', { matterClientIds: [] }],
  ['matterId', { matterId: '__MATTER__' }],
];

describe('while the invoice is live', () => {
  it.each(FROZEN)('refuses a change of %s and leaves the row as it was', async (_field, body) => {
    const before = await stored();
    const payload = JSON.parse(JSON.stringify(body).replace('__MATTER__', matterId));

    const res = await edit(payload);

    expect(res.status).toBe(403);
    expect(await stored()).toEqual(before);
  });

  it('refuses a charge-code change even to another real code', async () => {
    const before = await stored();
    const res = await edit({ chargeCodeId });
    expect(res.status).toBe(403);
    expect(await stored()).toEqual(before);
  });

  it('still lets the description and UTBMS task code be corrected', async () => {
    const res = await edit({ description: 'Corrected', utbmsTaskCode: 'L120' });

    expect(res.status).toBe(200);
    expect(await stored()).toMatchObject({ description: 'Corrected', utbms_task_code: 'L120', hours: '1.50', rate: 25_000 });
  });

  it('refuses the delete and keeps the row', async () => {
    const res = await owner.api.delete(`${T()}/client/${client.id}/${entryId}`);
    expect(res.status).toBe(403);
    expect(await stored()).toBeTruthy();
  });
});

describe('after the invoice is voided', () => {
  it('lets every frozen field change, including a move onto a matter, then delete', async () => {
    const voided = await owner.api.post(`${INV()}/${invoiceId}/void`);
    expect(voided.status).toBe(200);
    await drainEvents();

    expect((await edit({ hours: 2, hourlyRate: 300, date: '2026-03-11', billable: true, chargeCodeId })).status).toBe(200);
    expect(await stored()).toMatchObject({ hours: '2.00', rate: 30_000, day: '2026-03-11', billing_code_id: chargeCodeId, resolved: 30_000 });

    const moved = await edit({ matterId });
    expect(moved.status).toBe(200);
    expect(await stored()).toMatchObject({ matter_id: matterId, client_id: null });

    const del = await owner.api.delete(`${T()}/matter/${matterId}/${entryId}`);
    expect(del.status).toBe(200);
    const gone = await testPool.query('select 1 from activities where id = $1', [entryId]);
    expect(gone.rows).toHaveLength(0);
  });
});
