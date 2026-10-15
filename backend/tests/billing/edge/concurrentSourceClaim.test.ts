/**
 * Two invoices cannot claim one entry, even when both requests pass the pre-read.
 *
 * The create path reads which sources are billed, then re-checks under a
 * per-context advisory lock. This spec holds that lock itself, lets two creates
 * for the same entries queue behind it (both have already passed the unlocked
 * read), then releases it, so the outcome is decided by the locked check and not
 * by timing.
 *
 * RED IF: both invoices are created, or neither is, or the loser leaves a
 * partial invoice behind, or a different entry in the same request set is lost.
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

async function waitForAdvisoryWaiters(count: number) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const { rows } = await testPool.query(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`);
    if (rows[0].n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fewer than ${count} requests queued on the context lock`);
}

/** Hold the billing-context lock, run `fire`, wait for `waiters` to queue, release. */
async function raceUnderContextLock<T>(contextKey: string, waiters: number, fire: () => Promise<T>) {
  const held = await testPool.connect();
  try {
    await held.query('begin');
    await held.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`invoice-sources:${firm.id}:${contextKey}`]);
    const pending = fire();
    await waitForAdvisoryWaiters(waiters);
    await held.query('commit');
    return await pending;
  } finally {
    await held.query('rollback').catch(() => undefined);
    held.release();
  }
}

const liveLines = async (sourceId: string) => Number((await testPool.query(
  `select count(*)::int as n from invoice_line_items li join invoices i on i.id = li.invoice_id
    where li.source_id = $1 and i.status <> 'voided'`, [sourceId])).rows[0].n);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Race Client', email: 'race@example.test' });
  await drainEvents();
});

it('lets exactly one of two client invoices claim the same time entry and expense', async () => {
  const entry = await owner.api.post(T()).send({
    clientId: client.id, userId: owner.uid, hours: 1, date: '2026-03-10', hourlyRate: 100,
  });
  const expense = await owner.api.post(E()).send({
    clientId: client.id, description: 'Courier', amount: 20, date: '2026-03-10',
  });
  const entryId = entry.body.timeEntry.id as string;
  const expenseId = expense.body.expenseId as string;
  const make = (name: string) => owner.api.post(`${INV()}/client/${client.id}`).send({
    invoiceName: name, invoiceDate: '2026-03-15',
    timeEntries: [{ id: entryId, hours: 1, rate: 100, amount: 100 }],
    expenses: [{ id: expenseId, description: 'Courier', amount: 20 }],
    totalAmount: 120,
  });

  const results = await raceUnderContextLock(`client:${client.id}`, 2, () => Promise.all([make('Race A'), make('Race B')]));

  expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
  expect(results.find((r) => r.status === 400)!.body.error).toMatch(/already billed/i);
  expect(await liveLines(entryId)).toBe(1);
  expect(await liveLines(expenseId)).toBe(1);
  const invoices = await testPool.query('select count(*)::int as n from invoices where law_firm_id = $1', [firm.id]);
  expect(invoices.rows[0].n).toBe(1);
});

it('lets exactly one of two matter invoices for different clients of the matter claim the same entry', async () => {
  const other = await createPersonClient(firm.id, { name: 'Co-client', email: 'co@example.test' });
  const matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id, other.id] });
  const entry = await owner.api.post(T()).send({
    matterId, matterClientIds: [client.id, other.id], userId: owner.uid, hours: 2, date: '2026-03-10', hourlyRate: 150,
  });
  expect(entry.status).toBe(201);
  const entryId = entry.body.timeEntry.id as string;
  const make = (name: string, clientId: string) => owner.api.post(INV()).send({
    matterId, clientId, invoiceName: name, invoiceDate: '2026-03-15',
    timeEntries: [{ id: entryId, hours: 2, rate: 150, amount: 300 }],
    totalAmount: 300,
  });

  const results = await raceUnderContextLock(`matter:${matterId}`, 2, () => Promise.all([
    make('Client A bill', client.id), make('Client B bill', other.id),
  ]));

  expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
  expect(await liveLines(entryId)).toBe(1);
});
