/**
 * An invoice built from time, a flat fee and an expense, exported as LEDES 1998B.
 *
 * RED IF: the time and flat-fee lines stop carrying their exact cents, or the
 * export stops stating the invoice's persisted total.
 */
import {
  createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const INV = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

function parse(text: string) {
  const lines = text.split('\r\n');
  return lines.slice(2).filter((l) => l.length > 0).map((l) => l.replace(/\[\]$/, '').split('|'));
}
const cents = (v: string) => Math.round(Number(v) * 100);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Ledes Mixed', email: 'ledes-mixed@example.test' });
  await drainEvents();
});

async function exportMixed() {
  const created = await owner.api.post(INV()).send({
    invoiceName: 'Mixed', invoiceDate: '2026-04-05', dueDate: '2026-05-05',
    timeEntries: [{ date: '2026-04-01', hours: 1.5, rate: 111.11, amount: 166.67, name: 'Drafting' }],
    flatFees: [{ date: '2026-04-02', description: 'Filing', amount: 50.25 }],
    expenses: [{ date: '2026-04-03', description: 'Courier', amount: 20.5 }],
    totalAmount: 237.42, flatFeesAmount: 50.25,
  });
  expect(created.status).toBe(201);
  expect(created.body.invoice.totalAmount).toBe(237.42);
  await drainEvents();
  const res = await owner.api.get(`${INV()}/${created.body.invoice.id}/export/ledes`);
  expect(res.status).toBe(200);
  return parse(res.text);
}

it('carries the exact cents of the time and flat-fee lines and the invoice total', async () => {
  const rows = await exportMixed();
  expect(rows[0][4]).toBe('237.42');

  const time = rows.find((r) => r[18] === 'Drafting')!;
  const fee = rows.find((r) => r[18] === 'Filing')!;
  expect([time[10], time[12], time[20]]).toEqual(['1.50', '166.67', '111.11']);
  expect([fee[10], fee[12], fee[20]]).toEqual(['1.00', '50.25', '50.25']);
});
