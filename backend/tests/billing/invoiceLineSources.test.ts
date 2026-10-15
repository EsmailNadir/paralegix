/**
 * What an invoice line may claim as its source.
 *
 * A line that carries a source id (a time entry, an expense or a flat fee)
 * names a real activity of the invoice's own firm and context, because that id
 * is what freezes the activity and takes it out of the unbilled lists. A line
 * with no source id is a manual line: it is billed as typed and nothing points
 * at it, so no activity is ever frozen or released on its account.
 *
 * RED IF:
 *  - an id that names no activity (random uuid, a placeholder string, another
 *    firm's activity) is accepted on create, split, bulk or line edit, which
 *    leaves a line that looks sourced but protects nothing;
 *  - a line with no id is refused, or makes some activity read as billed;
 *  - a real activity stops freezing once billed.
 */
import { randomUUID } from 'crypto';
import {
  testPool, createFirm, createPersonClient, createOrgClient, ownerOf, drainEvents,
  type Actor, type Firm, type ClientRecord,
} from '../support/setupInProcess';
import { seedMatter } from '../support/matters';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const B = () => `/api/lawfirms/${firm.id}/billing`;
const CLIENT_INV = () => `${B()}/invoices/client/${client.id}`;
const MISSING = /do not exist/i;

const invoiceCount = async () => Number((await testPool.query(
  'select count(*)::int as n from invoices where law_firm_id = $1', [firm.id])).rows[0].n);
const lineCount = async () => Number((await testPool.query(
  'select count(*)::int as n from invoice_line_items where law_firm_id = $1', [firm.id])).rows[0].n);

async function seedTimeEntry(opts: { matterId?: string; lawFirmId?: string; clientId?: string } = {}) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into activities (kind, id, law_firm_id, matter_id, client_id, user_id, activity_date, hours, rate_cents, description)
     values ('time', $1, $2, $3, $4, $5, date '2026-03-10', 2, 10000, 'Drafting') returning id`,
    [id, opts.lawFirmId ?? firm.id, opts.matterId ?? null,
      opts.matterId ? null : (opts.clientId ?? client.id), owner.uid]);
  expect(res.rowCount).toBe(1);
  return id;
}

async function seedFlatFee(opts: { matterId?: string } = {}) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into activities (kind, id, law_firm_id, matter_id, client_id, description, charge_cents, activity_date)
     values ('flat_fee', $1, $2, $3, $4, 'Filing fee', 25000, date '2026-03-10') returning id`,
    [id, firm.id, opts.matterId ?? null, opts.matterId ? null : client.id]);
  expect(res.rowCount).toBe(1);
  return id;
}

async function seedExpense() {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into activities (kind, id, law_firm_id, client_id, description, charge_cents, activity_date, billable)
     values ('expense', $1, $2, $3, 'Courier', 4200, date '2026-03-10', true) returning id`,
    [id, firm.id, client.id]);
  expect(res.rowCount).toBe(1);
  return id;
}

const unbilledIds = async () => {
  const res = await owner.api.get(`${CLIENT_INV()}/unbilled-summary`);
  expect(res.status).toBe(200);
  return {
    time: res.body.unbilledTimeEntries.map((e: any) => e.id).sort(),
    fees: res.body.unbilledFlatFees.map((f: any) => f.id).sort(),
    hours: res.body.totalUnbilledHours,
  };
};

const createOnClient = (body: Record<string, unknown>) =>
  owner.api.post(CLIENT_INV()).send({ invoiceName: `Inv ${randomUUID().slice(0, 6)}`, invoiceDate: '2026-03-15', ...body });

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Source Client', email: 'source@example.test' });
  await drainEvents();
});

describe('create refuses a source id that names no activity', () => {
  it('refuses an unknown time entry id and writes nothing', async () => {
    const res = await createOnClient({
      timeEntries: [{ id: randomUUID(), hours: 2, rate: 100, amount: 200 }], totalAmount: 200,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(MISSING);
    expect(await invoiceCount()).toBe(0);
    expect(await lineCount()).toBe(0);
  });

  it('refuses an unknown expense id', async () => {
    const res = await createOnClient({
      expenses: [{ id: randomUUID(), description: 'Courier', amount: 42 }], totalAmount: 42,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(MISSING);
    expect(await invoiceCount()).toBe(0);
  });

  it('refuses an unknown flat fee id', async () => {
    const res = await createOnClient({
      flatFees: [{ id: randomUUID(), description: 'Retainer', amount: 500 }], totalAmount: 500, flatFeesAmount: 500,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(MISSING);
    expect(await invoiceCount()).toBe(0);
  });

  it('refuses a placeholder string that is not a uuid', async () => {
    const res = await createOnClient({
      flatFees: [{ id: 'flat-fee-1700000000000', description: 'Retainer', amount: 500 }],
      totalAmount: 500, flatFeesAmount: 500,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(MISSING);
    expect(await lineCount()).toBe(0);
  });

  it('refuses a real activity of another firm', async () => {
    const other = await createFirm();
    const otherOwner = await ownerOf(other.id);
    const otherClient = await createPersonClient(other.id, { name: 'Elsewhere' });
    const foreign = randomUUID();
    await testPool.query(
      `insert into activities (kind, id, law_firm_id, client_id, user_id, activity_date, hours, rate_cents, description)
       values ('time', $1, $2, $3, $4, date '2026-03-10', 2, 10000, 'Foreign')`,
      [foreign, other.id, otherClient.id, otherOwner.uid]);

    const res = await createOnClient({
      timeEntries: [{ id: foreign, hours: 2, rate: 100, amount: 200 }], totalAmount: 200,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(MISSING);
    expect(await invoiceCount()).toBe(0);
  });

  it('refuses a plan fee id that names no plan period', async () => {
    const res = await createOnClient({
      flatFees: [{ id: `plan-${randomUUID()}-2026-03-01`, description: 'Retainer', amount: 500 }],
      totalAmount: 500, flatFeesAmount: 500,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(MISSING);
  });
});

describe('a real activity still bills and freezes', () => {
  it('bills an existing time entry, takes it off the unbilled list and freezes its hours', async () => {
    const id = await seedTimeEntry();
    const before = await unbilledIds();
    expect(before.time).toEqual([id]);

    const res = await createOnClient({
      timeEntries: [{ id, hours: 2, rate: 100, amount: 200 }], totalAmount: 200,
    });
    expect(res.status).toBe(201);

    expect((await unbilledIds()).time).toEqual([]);
    await expect(testPool.query(`update activities set hours = 9 where kind = 'time' and id = $1`, [id]))
      .rejects.toThrow(/on an invoice/);
  });
});

describe('a line with no source id is a manual line', () => {
  it('is billed as typed, stored without a source, and leaves every activity unbilled', async () => {
    const entryId = await seedTimeEntry();
    const before = await unbilledIds();

    const res = await createOnClient({
      timeEntries: [{ description: 'Phone call', hours: 1.5, rate: 120, amount: 180 }],
      flatFees: [{ description: 'Courier surcharge', amount: 35 }],
      totalAmount: 215, flatFeesAmount: 35,
    });
    expect(res.status).toBe(201);
    expect(res.body.invoice.totalAmount).toBe(215);
    expect(res.body.invoice.timeEntries).toHaveLength(1);
    expect(res.body.invoice.timeEntries[0].id).toBeUndefined();
    expect(res.body.invoice.timeEntries[0].description).toBe('Phone call');
    expect(res.body.invoice.flatFees[0].id).toBeUndefined();

    const { rows } = await testPool.query(
      `select kind, source_id, amount_cents from invoice_line_items where invoice_id = $1 order by kind`,
      [res.body.invoice.id]);
    expect(rows.map((r: any) => [r.kind, r.source_id, Number(r.amount_cents)]))
      .toEqual([['flat_fee', null, 3500], ['time_entry', null, 18000]]);

    expect(await unbilledIds()).toEqual(before);
    expect(before.time).toEqual([entryId]);
  });
});

describe('editing lines applies the same rule', () => {
  let invoiceId: string;
  beforeEach(async () => {
    const created = await createOnClient({
      flatFees: [{ description: 'Original fee', amount: 1000 }], totalAmount: 1000, flatFeesAmount: 1000,
    });
    expect(created.status).toBe(201);
    invoiceId = created.body.invoice.id;
  });
  const patch = (body: Record<string, unknown>) =>
    owner.api.patch(`${CLIENT_INV()}/${invoiceId}/line-items`).send({
      timeEntries: [], flatFees: [], expenses: [], ...body,
    });

  it('refuses a line that adds an unknown id and keeps the stored lines', async () => {
    const res = await patch({
      flatFees: [{ description: 'Original fee', amount: 1000 }],
      expenses: [{ id: randomUUID(), description: 'Courier', amount: 20 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(MISSING);
    const { rows } = await testPool.query(
      'select kind, amount_cents from invoice_line_items where invoice_id = $1', [invoiceId]);
    expect(rows.map((r: any) => [r.kind, Number(r.amount_cents)])).toEqual([['flat_fee', 100000]]);
  });

  it('accepts a manual line added without an id', async () => {
    const res = await patch({
      flatFees: [{ description: 'Original fee', amount: 1000 }],
      expenses: [{ description: 'Courier', amount: 20 }],
    });
    expect(res.status).toBe(200);
    const { rows } = await testPool.query(
      'select kind, source_id, amount_cents from invoice_line_items where invoice_id = $1 order by kind', [invoiceId]);
    expect(rows.map((r: any) => [r.kind, r.source_id, Number(r.amount_cents)]))
      .toEqual([['expense', null, 2000], ['flat_fee', null, 100000]]);
  });

  it('accepts a real activity added by id', async () => {
    const id = await seedExpense();
    const res = await patch({
      flatFees: [{ description: 'Original fee', amount: 1000 }],
      expenses: [{ id, description: 'Courier', amount: 42 }],
    });
    expect(res.status).toBe(200);
    const { rows } = await testPool.query(
      `select source_id from invoice_line_items where invoice_id = $1 and kind = 'expense'`, [invoiceId]);
    expect(rows).toEqual([{ source_id: id }]);
  });
});

describe('split create', () => {
  let matterId: string;
  let personA: ClientRecord;
  let orgB: ClientRecord;
  let entryId: string;

  beforeEach(async () => {
    personA = await createPersonClient(firm.id, { name: 'Pat Person' });
    orgB = await createOrgClient(firm.id, { name: 'Acme Corporation' });
    matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [personA.id, orgB.id] });
    entryId = await seedTimeEntry({ matterId });
  });

  const split = (invoices: unknown[], timeEntries: string[] = [entryId]) =>
    owner.api.post(`${B()}/invoices/matter/${matterId}/split`).send({
      invoiceDate: '2026-03-15', splitMode: 'equal', sourceSelection: { timeEntries, flatFees: [] }, invoices,
    });
  const share = (clientId: string, name: string, lineId: string | undefined, amount = 100, hours = 1) => ({
    matterClientId: clientId, invoiceName: name, totalAmount: amount, totalHours: hours, allocationPercent: 50,
    timeEntries: [{ ...(lineId ? { id: lineId } : {}), amount, hours, allocationPercent: 50 }],
  });

  it('refuses a selection that names an unknown time entry', async () => {
    const ghost = randomUUID();
    const res = await split([share(personA.id, 'A', ghost, 200, 2)], [ghost]);
    expect(res.status).toBe(400);
    expect(await invoiceCount()).toBe(0);
  });

  it('refuses a share line that names an unknown time entry', async () => {
    const res = await split([
      share(personA.id, 'A', randomUUID()),
      share(orgB.id, 'B', entryId),
    ]);
    expect(res.status).toBe(400);
    expect(await invoiceCount()).toBe(0);
  });

  it('refuses a placeholder id on a share line', async () => {
    const res = await split([
      share(personA.id, 'A', `manual-te-${Date.now()}`),
      share(orgB.id, 'B', entryId),
    ]);
    expect(res.status).toBe(400);
    expect(await invoiceCount()).toBe(0);
  });

  it('takes a share line with no id as a manual line billed as typed', async () => {
    const res = await owner.api.post(`${B()}/invoices/matter/${matterId}/split`).send({
      invoiceDate: '2026-03-15', splitMode: 'equal',
      sourceSelection: { timeEntries: [entryId], flatFees: [] },
      invoices: [
        {
          matterClientId: personA.id, invoiceName: 'A', totalAmount: 150, totalHours: 1.5, allocationPercent: 50,
          timeEntries: [
            { id: entryId, amount: 100, hours: 1, allocationPercent: 50 },
            { description: 'Typed extra', amount: 50, hours: 0.5 },
          ],
        },
        share(orgB.id, 'B', entryId, 100, 1),
      ],
    });
    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      `select source_id from invoice_line_items li join invoices i on i.id = li.invoice_id
        where i.law_firm_id = $1 and li.source_id is not null`, [firm.id]);
    // The entry is divided across both shares, so each share line names it.
    expect(rows).toEqual([{ source_id: entryId }, { source_id: entryId }]);
    const typed = await testPool.query(
      `select amount_cents from invoice_line_items where law_firm_id = $1 and description = 'Typed extra'`, [firm.id]);
    expect(typed.rows.map((r: any) => Number(r.amount_cents))).toEqual([5000]);
  });
});

describe('bulk create', () => {
  it('refuses a context selection that names an unknown time entry and writes nothing', async () => {
    const matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
    await seedTimeEntry({ matterId });
    const res = await owner.api.post(`${B()}/invoices/bulk`).send({
      invoiceDate: '2026-03-15',
      contexts: [{ type: 'matter', entityId: matterId, timeEntryIds: [randomUUID()] }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(MISSING);
    expect(await invoiceCount()).toBe(0);
  });

  it('refuses a context selection that names an unknown flat fee', async () => {
    const matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
    await seedFlatFee({ matterId });
    const res = await owner.api.post(`${B()}/invoices/bulk`).send({
      invoiceDate: '2026-03-15',
      contexts: [{ type: 'matter', entityId: matterId, flatFeeIds: [randomUUID()] }],
    });
    expect(res.status).toBe(400);
    expect(await invoiceCount()).toBe(0);
  });
});
