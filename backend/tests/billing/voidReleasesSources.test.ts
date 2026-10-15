/**
 * Voiding an invoice gives its work back.
 *
 * The firm cancels a bill to re-bill the work correctly. Until now the voided
 * invoice's line items still named every time entry, flat fee and expense on
 * it, so the work stayed frozen and could never go on another invoice.
 *
 * RED IF: any reader of "billed" counts a line item on a voided invoice
 * (unbilled summary, firm time-entry list, flat-fee list, the edit guard, the
 * create and edit availability checks, or the database trigger), OR a live
 * invoice stops freezing what it holds.
 */
import { randomUUID } from 'crypto';

import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type ClientRecord, type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const TE = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const INV = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

async function logTime() {
  const res = await owner.api.post(TE()).send({
    clientId: client.id, userId: owner.uid, hours: 1.5, date: '2026-03-10',
    description: 'Drafted the motion', hourlyRate: 250,
  });
  expect(res.status).toBe(201);
  return res.body.timeEntry.id as string;
}

const billEntry = (entryId: string, name: string) => owner.api.post(INV()).send({
  invoiceName: name, invoiceDate: '2026-03-15', dueDate: '2026-04-15',
  timeEntries: [{ id: entryId, hours: 1.5, rate: 250, amount: 375 }],
  totalAmount: 375, totalHours: 1.5,
});

async function voidInvoice(invoiceId: string) {
  const res = await owner.api.post(`${INV()}/${invoiceId}/void`);
  expect(res.status).toBe(200);
  await drainEvents();
}

const unbilled = async () => {
  const res = await owner.api.get(`${INV()}/unbilled-summary`);
  expect(res.status).toBe(200);
  return res.body;
};
const hoursOf = async (id: string) => Number((await testPool.query(
  `select hours from activities where kind = 'time' and id = $1`, [id])).rows[0].hours);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Rebill Client', email: 'rebill@example.test' });
});

describe('a time entry on a voided invoice', () => {
  it('goes back to the unbilled pool', async () => {
    const entryId = await logTime();
    const billed = await billEntry(entryId, 'First');
    expect(billed.status).toBe(201);
    expect((await unbilled()).unbilledTimeEntries.map((e: any) => e.id)).not.toContain(entryId);

    await voidInvoice(billed.body.invoice.id);

    expect((await unbilled()).unbilledTimeEntries.map((e: any) => e.id)).toContain(entryId);
  });

  it('reads as unbilled in the firm time-entry list', async () => {
    const entryId = await logTime();
    const billed = await billEntry(entryId, 'First');
    const status = async () => (await owner.api.get(`${TE()}/firm`)).body.timeEntries
      .find((e: any) => e.id === entryId).billingStatus;
    expect(await status()).toBe('billed');

    await voidInvoice(billed.body.invoice.id);

    expect(await status()).toBe('unbilled');
  });

  it('can be corrected again: the hours change succeeds', async () => {
    const entryId = await logTime();
    const billed = await billEntry(entryId, 'First');
    // Control: frozen while the invoice is live.
    expect((await owner.api.put(`${TE()}/client/${client.id}/${entryId}`).send({ hours: 9 })).status).toBe(403);

    await voidInvoice(billed.body.invoice.id);

    const res = await owner.api.put(`${TE()}/client/${client.id}/${entryId}`).send({ hours: 2 });
    expect(res.status).toBe(200);
    expect(await hoursOf(entryId)).toBe(2);
  });

  it('can go on a new invoice, which freezes it again', async () => {
    const entryId = await logTime();
    const first = await billEntry(entryId, 'First');
    expect((await billEntry(entryId, 'Blocked while live')).status).toBe(400);
    await voidInvoice(first.body.invoice.id);

    const second = await billEntry(entryId, 'Rebilled');
    expect(second.status).toBe(201);

    // The new invoice is live, so the ordinary rules are back.
    expect((await owner.api.put(`${TE()}/client/${client.id}/${entryId}`).send({ hours: 9 })).status).toBe(403);
    const third = await billEntry(entryId, 'Double bill');
    expect(third.status).toBe(400);
    expect(third.body.error).toMatch(/already billed/i);
  });

  it('does not block editing the line items of the invoice that re-billed it', async () => {
    const entryId = await logTime();
    const first = await billEntry(entryId, 'First');
    await voidInvoice(first.body.invoice.id);
    const second = await billEntry(entryId, 'Rebilled');

    // Same source, still named by the voided invoice. The availability check
    // under the context lock must ignore that line.
    const res = await owner.api.patch(`${INV()}/${second.body.invoice.id}/line-items`).send({
      timeEntries: [{ id: entryId, hours: 1, rate: 250, amount: 250 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.invoice.totalAmount).toBe(250);
  });
});

describe('flat fees and expenses on a voided invoice', () => {
  it('go back to the unbilled pool and the flat-fee list reads them unbilled', async () => {
    const feeId = randomUUID();
    const expenseId = randomUUID();
    await testPool.query(
      `insert into activities (kind, id, law_firm_id, client_id, description, charge_cents, activity_date)
       values ('flat_fee', $1, $2, $3, 'Filing', 50000, '2026-03-01')`, [feeId, firm.id, client.id]);
    await testPool.query(
      `insert into activities (kind, id, law_firm_id, client_id, description, charge_cents, activity_date, billable)
       values ('expense', $1, $2, $3, 'Courier', 4200, '2026-03-01', true)`, [expenseId, firm.id, client.id]);

    const billed = await owner.api.post(INV()).send({
      invoiceName: 'Fees', invoiceDate: '2026-03-15', dueDate: '2026-04-15',
      flatFees: [{ id: feeId, description: 'Filing', amount: 500 }],
      expenses: [{ id: expenseId, description: 'Courier', amount: 42 }],
      totalAmount: 542, flatFeesAmount: 500,
    });
    expect(billed.status).toBe(201);
    const before = await unbilled();
    expect(before.unbilledFlatFees.map((f: any) => f.id)).not.toContain(feeId);
    expect(before.unbilledExpenses.map((e: any) => e.id)).not.toContain(expenseId);

    await voidInvoice(billed.body.invoice.id);

    const after = await unbilled();
    expect(after.unbilledFlatFees.map((f: any) => f.id)).toContain(feeId);
    expect(after.unbilledExpenses.map((e: any) => e.id)).toContain(expenseId);
    const fee = (await owner.api.get(`/api/lawfirms/${firm.id}/billing/flat-fees/firm`)).body.flatFees
      .find((f: any) => f.id === feeId);
    expect(fee.isBilled).toBe(false);
  });
});
