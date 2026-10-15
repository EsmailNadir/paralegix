/**
 * Work on a matter with several clients: attribution, three-way splits and
 * single billing.
 *
 * RED IF: an entry named for two clients is listed more or fewer than once per
 * client, a three-way split of odd cents stops adding up to the entry's cents or
 * hours, a split entry can be billed again to any of its clients, or invoicing
 * one client frees the entry for the other.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';
import { seedMatter } from '../../support/matters';

const { allocateWorkToPayers } = require('../../../src/modules/billing/shared/splitAllocation');

let firm: Firm;
let owner: Actor;
let clients: ClientRecord[];
let matterId: string;

const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const INV = () => `/api/lawfirms/${firm.id}/billing/invoices`;
const SUMMARY = () => `${INV()}/matter/${matterId}/unbilled-summary`;

async function logTime(hours: number, rate: number, matterClientIds: string[] = [], date = '2026-03-10') {
  const res = await owner.api.post(T()).send({
    matterId, matterClientIds, userId: owner.uid, hours, date, hourlyRate: rate, description: `Work ${hours}`,
  });
  expect(res.status).toBe(201);
  return res.body.timeEntry.id as string;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  clients = [];
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    clients.push(await createPersonClient(firm.id, { name, email: `${name.toLowerCase()}@example.test` }));
  }
  matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: clients.map((c) => c.id) });
  await drainEvents();
});

describe('who an entry is listed under', () => {
  it('lists an entry named for two clients once under each of them and not under the third', async () => {
    const both = await logTime(1, 100, [clients[0].id, clients[1].id]);
    const onlyC = await logTime(2, 100, [clients[2].id]);
    const nobody = await logTime(3, 100, []);

    const idsFor = async (clientId: string) => {
      const res = await owner.api.get(`${T()}/firm`).query({ clientId });
      expect(res.status).toBe(200);
      return res.body.timeEntries.map((e: any) => e.id).sort();
    };

    expect(await idsFor(clients[0].id)).toEqual([both]);
    expect(await idsFor(clients[1].id)).toEqual([both]);
    expect(await idsFor(clients[2].id)).toEqual([onlyC]);
    expect(nobody).toBeTruthy();
  });
});

describe('a three-way split of odd cents', () => {
  it('adds up to each entry exactly in cents and hours, then frees nothing for a second bill', async () => {
    const a = await logTime(1.01, 100.01);
    const b = await logTime(0.07, 333.33);
    const summary = await owner.api.get(SUMMARY());
    const source = summary.body.unbilledTimeEntries;
    expect(source.map((e: any) => Math.round(e.amount * 100)).sort((x: number, y: number) => x - y))
      .toEqual([2333, 10101].sort((x, y) => x - y));

    const allocation = allocateWorkToPayers({
      payers: [
        { clientId: clients[0].id, portionBp: 3334 },
        { clientId: clients[1].id, portionBp: 3333 },
        { clientId: clients[2].id, portionBp: 3333 },
      ],
      timeEntries: source.map((e: any) => ({ id: e.id, hours: e.hours, rate: e.rate, amount: e.amount, date: e.date, name: e.name })),
      flatFees: [],
    });
    const invoices = allocation.map((payer: any, i: number) => ({
      matterClientId: payer.clientId,
      invoiceName: `Share ${i + 1}`,
      timeEntries: payer.timeEntries.map((line: any) => ({
        id: line.source.id, name: line.source.name, date: line.source.date, rate: line.source.rate,
        hours: line.allocationHours, amount: line.allocationAmount,
        allocationPercent: line.allocationPercent, allocationAmount: line.allocationAmount,
      })),
      totalHours: payer.totalHours, totalAmount: payer.totalAmount, flatFeesAmount: 0,
    }));
    const body = {
      invoiceDate: '2026-03-15', dueDate: '2026-04-15', splitMode: 'percentage',
      sourceSelection: { timeEntries: source.map((e: any) => e.id), flatFees: [] },
      invoices,
    };

    const res = await owner.api.post(`${INV()}/matter/${matterId}/split`).send(body);

    expect(res.status).toBe(201);
    const lines = await testPool.query(
      `select source_id, sum(amount_cents)::int as cents, sum(quantity)::text as hours, count(*)::int as n
         from invoice_line_items where law_firm_id = $1 and kind = 'time_entry' group by source_id`, [firm.id]);
    const byId = new Map(lines.rows.map((r: any) => [r.source_id, r]));
    expect(byId.get(a)).toMatchObject({ cents: 10_101, hours: '1.01', n: 3 });
    expect(byId.get(b)).toMatchObject({ cents: 2_333, hours: '0.07', n: 3 });
    const totals = await testPool.query(
      `select sum(total_cents)::int as total from invoices where law_firm_id = $1`, [firm.id]);
    expect(totals.rows[0].total).toBe(12_434);

    const again = await owner.api.post(`${INV()}/matter/${matterId}/split`).send({
      ...body, invoices: invoices.map((inv: any, i: number) => ({ ...inv, invoiceName: `Again ${i}` })),
    });
    expect(again.status).toBe(400);
    const after = await owner.api.get(SUMMARY());
    expect(after.body.unbilledTimeEntries).toEqual([]);
  });
});

describe('invoicing one client then the other', () => {
  it('does not free the entry for the second client', async () => {
    const id = await logTime(2, 150, [clients[0].id, clients[1].id]);
    const line = [{ id, hours: 2, rate: 150, amount: 300 }];
    const first = await owner.api.post(INV()).send({
      matterId, clientId: clients[0].id, invoiceName: 'Alpha bill', invoiceDate: '2026-03-15', timeEntries: line, totalAmount: 300,
    });
    expect(first.status).toBe(201);

    const second = await owner.api.post(INV()).send({
      matterId, clientId: clients[1].id, invoiceName: 'Bravo bill', invoiceDate: '2026-03-15', timeEntries: line, totalAmount: 300,
    });

    expect(second.status).toBe(400);
    const summary = await owner.api.get(SUMMARY());
    expect(summary.body.unbilledTimeEntries.map((e: any) => e.id)).not.toContain(id);
    const live = await testPool.query(
      `select count(*)::int as n from invoice_line_items li join invoices i on i.id = li.invoice_id
        where li.source_id = $1 and i.status <> 'voided'`, [id]);
    expect(live.rows[0].n).toBe(1);
  });
});
