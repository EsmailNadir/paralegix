/**
 * An edit or delete of an entry that an invoice claims between the service's
 * "is it billed" read and its write.
 *
 * The write is stopped at the repository, an invoice claiming the entry is created
 * in the gap, and the write is released. The database trigger refuses it; the
 * caller must still get a clean refusal and the entry must keep its billed figures.
 *
 * RED IF: the late write changes the billed hours or deletes the entry, or the
 * refusal surfaces as a server error instead of a 4xx.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';
import { gateMethod, type Gate } from '../../support/gate';

const timeEntriesRepo = require('../../../src/modules/billing/timeEntries/timeEntries.repository');

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let entryId: string;
let gate: Gate | null = null;

const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const INV = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

const claim = () => owner.api.post(INV()).send({
  invoiceName: 'Claims it', invoiceDate: '2026-03-15',
  timeEntries: [{ id: entryId, hours: 1.5, rate: 250, amount: 375 }], totalAmount: 375,
});
const row = async () => (await testPool.query(
  `select hours::text as hours, rate_cents::int as rate from activities where id = $1`, [entryId])).rows[0];

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Race Client', email: 'edit-race@example.test' });
  const created = await owner.api.post(T()).send({
    clientId: client.id, userId: owner.uid, hours: 1.5, date: '2026-03-10', hourlyRate: 250, description: 'Work',
  });
  entryId = created.body.timeEntry.id;
  await drainEvents();
});
afterEach(() => { gate?.restore(); gate = null; });

it('refuses an hours edit that loses the race to an invoice, with a 4xx and the billed hours intact', async () => {
  gate = gateMethod(timeEntriesRepo, 'update');
  const editing = (async () => owner.api.put(`${T()}/client/${client.id}/${entryId}`).send({ hours: 9 }))();
  await gate.arrived(1);

  const invoice = await claim();
  expect(invoice.status).toBe(201);
  gate.open();
  const res = await editing;

  expect(await row()).toEqual({ hours: '1.50', rate: 25_000 });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
});

it('refuses a delete that loses the race to an invoice, with a 4xx and the entry kept', async () => {
  gate = gateMethod(timeEntriesRepo, 'delete');
  const deleting = (async () => owner.api.delete(`${T()}/client/${client.id}/${entryId}`))();
  await gate.arrived(1);

  const invoice = await claim();
  expect(invoice.status).toBe(201);
  gate.open();
  const res = await deleting;

  expect(await row()).toEqual({ hours: '1.50', rate: 25_000 });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
});
