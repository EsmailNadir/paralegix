/**
 * LEDES 1998B amounts against the invoice's stored cents.
 *
 * Every expected figure is an integer cent count taken from the seeded input or
 * from the stored `invoices.total_cents`, then formatted by this file's own
 * `fmt`, never by the export's formatter.
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

describe('LEDES amounts for time entries and flat fees', () => {
  it('prints the stored total on every row and line totals that add up to it', async () => {
    const { rows, totalCents } = await exportOf({
      totalAmount: 1234.55,
      timeEntries: [
        { date: '2026-04-02', hours: 0.07, rate: 123.45, amount: 8.64, name: 'A' },
        { date: '2026-04-03', hours: 8.99, rate: 0.01, amount: 0.09, name: 'B' },
      ],
      flatFees: [{ description: 'Fee', amount: 1225.82 }],
    });
    expect(totalCents).toBe(123_455);
    expect(rows).toHaveLength(3);
    rows.forEach((r) => expect(r[COL_INVOICE_TOTAL]).toBe(fmt(123_455)));
    expect(rows.map((r) => r[COL_LINE_TOTAL])).toEqual([fmt(864), fmt(9), fmt(122_582)]);
    const lineSum = rows.reduce((s, r) => s + Math.round(Number(r[COL_LINE_TOTAL]) * 100), 0);
    expect(lineSum).toBe(totalCents);
    expect(rows[0][COL_UNITS]).toBe('0.07');
    expect(rows[0][COL_UNIT_COST]).toBe('123.45');
    expect(rows[1][COL_UNITS]).toBe('8.99');
    expect(rows[1][COL_UNIT_COST]).toBe('0.01');
  });

  it('prints large and tiny amounts without float dust', async () => {
    const { rows } = await exportOf({
      totalAmount: 1_000_000.01,
      flatFees: [{ description: 'Big', amount: 1_000_000 }, { description: 'Cent', amount: 0.01 }],
    });
    expect(rows.map((r) => r[COL_LINE_TOTAL])).toEqual(['1000000.00', '0.01']);
    expect(rows[0][COL_INVOICE_TOTAL]).toBe('1000000.01');
  });
});
