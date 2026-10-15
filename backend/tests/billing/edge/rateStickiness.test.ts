/**
 * A rate is stamped on a time entry when it is written and moves only when the
 * entry's own rate inputs change or the firm asks to re-rate unbilled work.
 *
 * RED IF: a later change to a member's default rate re-prices existing work, the
 * re-rate touches an entry an invoice holds, the re-rate skips unbilled work, or
 * the rate on an invoice composer line differs from the entry's stored rate.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const INV = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

const setMemberRate = (dollars: number) => testPool.query(
  'update members set default_hourly_rate_cents = $3 where law_firm_id = $1 and user_id = $2',
  [firm.id, owner.uid, dollars * 100]);

async function logTime(hours = 1, date = '2026-03-10') {
  const res = await owner.api.post(T()).send({
    clientId: client.id, userId: owner.uid, hours, date, description: 'Work',
  });
  expect(res.status).toBe(201);
  return res.body.timeEntry.id as string;
}

const stored = async (id: string) => {
  const { rows } = await testPool.query(
    `select resolved_rate_cents::int as rate, rate_source, amount_cents::int as amount
       from activities where kind = 'time' and id = $1`, [id]);
  return rows[0];
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Rate Client', email: 'rate@example.test' });
  await setMemberRate(100);
  await drainEvents();
});

describe('a rate change after the entry exists', () => {
  it('leaves the existing entry at its stamped rate and prices only new entries at the new one', async () => {
    const before = await logTime();
    expect(await stored(before)).toEqual({ rate: 10_000, rate_source: 'user default rate', amount: 10_000 });

    await setMemberRate(200);
    const after = await logTime();

    expect(await stored(before)).toEqual({ rate: 10_000, rate_source: 'user default rate', amount: 10_000 });
    expect(await stored(after)).toEqual({ rate: 20_000, rate_source: 'user default rate', amount: 20_000 });
    const summary = await owner.api.get(`${INV()}/unbilled-summary`);
    const rateOf = (id: string) => summary.body.unbilledTimeEntries.find((e: any) => e.id === id).rate;
    expect(rateOf(before)).toBe(100);
    expect(rateOf(after)).toBe(200);
  });

  it('re-rates unbilled entries and skips the one an invoice holds', async () => {
    const billed = await logTime();
    const open = await logTime();
    const invoice = await owner.api.post(INV()).send({
      invoiceName: 'First', invoiceDate: '2026-03-15',
      timeEntries: [{ id: billed, hours: 1, rate: 100, amount: 100 }], totalAmount: 100,
    });
    expect(invoice.status).toBe(201);
    await setMemberRate(200);

    const res = await owner.api.post(`${T()}/client/${client.id}/rerate`).send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rerated: 1, skippedBilled: 1 });
    expect(await stored(billed)).toEqual({ rate: 10_000, rate_source: 'user default rate', amount: 10_000 });
    expect(await stored(open)).toEqual({ rate: 20_000, rate_source: 'user default rate', amount: 20_000 });
    const line = await testPool.query(
      `select rate_cents::int as rate, amount_cents::int as amount from invoice_line_items where source_id = $1`, [billed]);
    expect(line.rows[0]).toEqual({ rate: 10_000, amount: 10_000 });
  });

  it('keeps an explicit override through a re-rate', async () => {
    const res = await owner.api.post(T()).send({
      clientId: client.id, userId: owner.uid, hours: 1, date: '2026-03-10', hourlyRate: 350,
    });
    const id = res.body.timeEntry.id as string;
    await setMemberRate(200);

    await owner.api.post(`${T()}/client/${client.id}/rerate`).send({});

    expect(await stored(id)).toEqual({ rate: 35_000, rate_source: 'time entry override', amount: 35_000 });
  });
});
