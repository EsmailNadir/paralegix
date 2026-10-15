/**
 * LEDES export lists expense lines and the tax so line totals add up to INVOICE_TOTAL.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const BASE = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

const fmt = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

function parseLedes(text: string) {
  const lines = text.split('\r\n');
  return lines.slice(2).filter((l) => l.length > 0).map((l) => l.replace(/\[\]$/, '').split('|'));
}

const COL_INVOICE_TOTAL = 4;
const COL_LINE_TOTAL = 12;
const COL_UNITS = 10;
const COL_UNIT_COST = 20;

async function exportOf(body: Record<string, unknown>) {
  const created = await owner.api.post(BASE()).send({
    invoiceName: `Ledes ${randomUUID().slice(0, 6)}`, invoiceDate: '2026-04-05', ...body,
  });
  expect(created.status).toBe(201);
  const id = created.body.invoice.id as string;
  const totalCents = Number((await testPool.query('select total_cents from invoices where id = $1', [id])).rows[0].total_cents);
  const res = await owner.api.get(`${BASE()}/${id}/export/ledes`);
  expect(res.status).toBe(200);
  return { rows: parseLedes(res.text), totalCents };
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Ledes Edge Client' });
  await drainEvents();
});

describe('LEDES when the invoice also carries expenses or tax', () => {
  /**
   * INVOICE_TOTAL is the whole bill. A LEDES file whose line totals do not add
   * up to INVOICE_TOTAL is rejected by e-billing systems.
   */
  it('lists an expense line so the lines still add up to INVOICE_TOTAL', async () => {
    const expense = await owner.api.post(`/api/lawfirms/${firm.id}/billing/expenses`).send({
      clientId: client.id, description: 'Courier', amount: 50.25, date: '2026-04-03',
    });
    expect(expense.status).toBe(201);
    const { rows, totalCents } = await exportOf({
      totalAmount: 0,
      flatFees: [{ description: 'Fee', amount: 100 }],
      expenses: [{ id: expense.body.expense.id, description: 'Courier', amount: 50.25 }],
    });
    expect(totalCents).toBe(15_025);
    expect(rows[0][COL_INVOICE_TOTAL]).toBe(fmt(15_025));
    const lineSum = rows.reduce((s, r) => s + Math.round(Number(r[COL_LINE_TOTAL]) * 100), 0);
    expect(lineSum).toBe(15_025);
  });

  it('lists the tax so the lines still add up to INVOICE_TOTAL', async () => {
    const { rows, totalCents } = await exportOf({
      taxRate: 10,
      flatFees: [{ description: 'Fee', amount: 100 }],
    });
    expect(totalCents).toBe(11_000);
    const lineSum = rows.reduce((s, r) => s + Math.round(Number(r[COL_LINE_TOTAL]) * 100), 0);
    expect(lineSum).toBe(11_000);
  });
  it('lists an added amount as an invoice-level fee adjustment line', async () => {
    const created = await owner.api.post(BASE()).send({
      invoiceName: `Ledes ${randomUUID().slice(0, 6)}`, invoiceDate: '2026-04-05',
      flatFees: [{ description: 'Fee', amount: 100 }],
    });
    const id = created.body.invoice.id as string;
    const added = await owner.api.patch(`${BASE()}/${id}/add-amount`).send({ amount: 10.1 });
    expect(added.status).toBe(200);
    const res = await owner.api.get(`${BASE()}/${id}/export/ledes`);
    const rows = parseLedes(res.text);
    expect(rows[0][COL_INVOICE_TOTAL]).toBe(fmt(11_010));
    expect(rows.map((r) => r[9])).toEqual(['F', 'IF']);
    expect(rows.reduce((s, r) => s + Math.round(Number(r[COL_LINE_TOTAL]) * 100), 0)).toBe(11_010);
  });
});
