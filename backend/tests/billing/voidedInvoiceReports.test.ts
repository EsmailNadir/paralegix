/**
 * The billing reports after an invoice is voided.
 *
 * Seeded in SQL like billingReports.test.ts: the report is pure SQL over
 * `invoices.status`, and voiding writes exactly that column
 * (invoiceVoid.test.ts proves the route does).
 *
 * RED IF: the `invoice_money` CTE stops filtering `status <> 'voided'`. Then a
 * cancelled bill is billed, owed and named as the next payment on every card.
 */
import { randomUUID } from 'crypto';

import { testPool, createFirm, createPersonClient, ownerOf, type Actor, type Firm } from '../support/setupInProcess';
import { seedMatter } from '../support/matters';

let firm: Firm;
let owner: Actor;
let clientId: string;

const R = () => `/api/lawfirms/${firm.id}/billing/reports`;
const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function seedInvoice(opts: {
  matterId?: string; clientContextId?: string; clientId?: string | null;
  totalCents: number; dueDate: string; invoiceName: string; status?: string;
}) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into invoices
       (id, law_firm_id, matter_id, client_context_id, client_id, context_type,
        invoice_number, invoice_name, status, total_cents, invoice_date, due_date)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, current_date, $11)`,
    [id, firm.id, opts.matterId ?? null, opts.clientContextId ?? null, opts.clientId ?? null,
      opts.matterId ? 'matter' : 'client', `INV-${id.slice(0, 8)}`, opts.invoiceName,
      opts.status ?? 'outstanding', opts.totalCents, opts.dueDate],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

function rowNamed(body: any, name: string) {
  const matches = (body.rows ?? []).filter((r: any) => r.name === name);
  expect(matches).toHaveLength(1);
  return matches[0];
}

let cancelledMatterBill: string;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  clientId = (await createPersonClient(firm.id, { name: 'Ada Byron' })).id;
  const otherId = (await createPersonClient(firm.id, { name: 'Grace Hopper' })).id;

  const matterId = await seedMatter(firm.id, { name: 'Acme v. Globex', clientIds: [clientId] });
  await seedInvoice({ matterId, clientId, totalCents: 25_000, dueDate: dayOffset(10), invoiceName: 'Live bill' });
  // Due sooner than the live one, so a CTE that kept it would name it as the next payment.
  cancelledMatterBill = await seedInvoice({
    matterId, clientId, totalCents: 100_000, dueDate: dayOffset(2), invoiceName: 'Cancelled bill', status: 'voided',
  });

  // Client-direct invoices: the by-matter report's "unlinked" shortfall.
  await seedInvoice({ clientContextId: clientId, clientId, totalCents: 15_000, dueDate: dayOffset(20), invoiceName: 'Direct live' });
  await seedInvoice({ clientContextId: clientId, clientId, totalCents: 60_000, dueDate: dayOffset(5), invoiceName: 'Direct cancelled', status: 'voided' });

  // A matter with two clients and invoices naming nobody: the by-client report's "unattributed" note.
  const shared = await seedMatter(firm.id, { name: 'Shared Matter', clientIds: [clientId, otherId] });
  await seedInvoice({ matterId: shared, totalCents: 20_000, dueDate: dayOffset(30), invoiceName: 'Shared live' });
  await seedInvoice({ matterId: shared, totalCents: 70_000, dueDate: dayOffset(30), invoiceName: 'Shared cancelled', status: 'voided' });
});

describe('control: the same invoices count while they are live', () => {
  it('bills the cancelled invoice once its status is not voided', async () => {
    await testPool.query(`update invoices set status = 'outstanding' where id = $1`, [cancelledMatterBill]);
    const row = rowNamed((await owner.api.get(`${R()}/by-matter`)).body, 'Acme v. Globex');
    expect(row).toMatchObject({ invoiceCount: 2, totalBilled: 1250, nextPaymentInvoiceName: 'Cancelled bill' });
  });
});

describe('by matter', () => {
  it('counts the voided invoice but leaves it out of the money and the next payment', async () => {
    const res = await owner.api.get(`${R()}/by-matter`);
    expect(res.status).toBe(200);
    expect(rowNamed(res.body, 'Acme v. Globex')).toMatchObject({
      invoiceCount: 2,
      totalBilled: 250,
      totalOutstanding: 250,
      nextPaymentDate: dayOffset(10),
      nextPaymentInvoiceName: 'Live bill',
    });
  });

  it('keeps a matter whose only invoice was voided, at zero money', async () => {
    const onlyVoided = await seedMatter(firm.id, { name: 'Dropped Matter', clientIds: [clientId] });
    await seedInvoice({
      matterId: onlyVoided, clientId, totalCents: 90_000, dueDate: dayOffset(3), invoiceName: 'Dropped bill', status: 'voided',
    });

    const res = await owner.api.get(`${R()}/by-matter`);
    expect(rowNamed(res.body, 'Dropped Matter')).toMatchObject({
      invoiceCount: 1,
      totalBilled: 0,
      totalOutstanding: 0,
      nextPaymentDate: null,
    });
  });

  it('states only the live client-direct invoice as unlinked', async () => {
    const res = await owner.api.get(`${R()}/by-matter`);
    expect(res.body.unlinkedInvoices).toEqual({ count: 1, totalAmount: 150 });
  });
});

describe('by client', () => {
  it('bills the client for live invoices only', async () => {
    const res = await owner.api.get(`${R()}/by-client`);
    expect(res.status).toBe(200);
    // 250 (matter, sole client) + 150 (direct). The voided 1000 and 600 still
    // count as invoices but add no money.
    expect(rowNamed(res.body, 'Ada Byron')).toMatchObject({ invoiceCount: 4, totalBilled: 400, totalOutstanding: 400 });
  });

  it('states only the live unattributed invoice', async () => {
    const res = await owner.api.get(`${R()}/by-client`);
    expect(res.body.unattributedInvoices).toEqual({ count: 1, totalAmount: 200 });
  });

  it('breaks the client down by matter without the voided invoice', async () => {
    const res = await owner.api.get(`${R()}/by-client/${clientId}/matters`);
    expect(res.status).toBe(200);
    expect(res.body.matters.find((m: any) => m.name === 'Acme v. Globex'))
      .toMatchObject({ invoiceCount: 2, billed: 250, outstanding: 250 });
  });
});
