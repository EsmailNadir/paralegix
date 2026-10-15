/**
 * hours x rate on a time entry, from the stored entry to the invoice line.
 *
 * Postgres generates `activities.amount_cents` as `round(hours * rate_cents)`
 * on exact numerics, half away from zero. Every expected value here is an
 * integer computed from hundredths of an hour and cents of rate, so it is
 * independent of both Postgres and of any JS float product.
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

const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const INV = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

/** round-half-up of (hundredthsOfHour * rateCents) / 100, in integers. */
function expectedCents(hundredths: number, rateCents: number): number {
  const product = BigInt(hundredths) * BigInt(rateCents);
  return Number((product * 2n + 100n) / 200n);
}

async function logTime(hours: number, rateDollars: number) {
  const res = await owner.api.post(T()).send({
    context: 'client', clientId: client.id, userId: owner.uid, hours, date: '2026-03-10', hourlyRate: rateDollars,
  });
  expect(res.status).toBe(201);
  return res.body.timeEntry;
}

const storedCents = async (id: string) =>
  Number((await testPool.query('select amount_cents from activities where id = $1', [id])).rows[0].amount_cents);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Time Amount Client' });
  await drainEvents();
});

describe('a stored time entry amount', () => {
  const hours = [0.01, 0.07, 1.33, 8.99, 24.0];
  const rates = [123.45, 0.01, 999999.99];

  it.each(hours.flatMap((h) => rates.map((r) => [h, r])))(
    'is round(%p h x $%p) in whole cents, in the row and in the response',
    async (h, r) => {
      const entry = await logTime(h, r);
      const want = expectedCents(Math.round(h * 100), Math.round(r * 100));
      expect(await storedCents(entry.id)).toBe(want);
      expect(Math.round(entry.amount * 100)).toBe(want);
    },
  );

  it('prices exact half-cent products up, never down', async () => {
    // 0.01 h x $0.50 = 0.5 cents; 0.35 h x $27.50 = 962.5 cents.
    const a = await logTime(0.01, 0.5);
    const b = await logTime(0.35, 27.5);
    expect(await storedCents(a.id)).toBe(1);
    expect(await storedCents(b.id)).toBe(963);
  });
});

describe('the invoice line a time entry becomes', () => {
  /**
   * Hours and rate pairs whose exact product ends in a half cent, split by
   * which path prices them correctly: the summary prices 0.35 h x $27.50 right
   * and the line-item edit prices the other three right.
   */
  const summaryAgrees: Array<[number, number]> = [
    [0.35, 27.5], // 962.5 cents
    [1.33, 1], // whole cents
    [8.99, 123.45], // 11098.2 cents
  ];
  const resaveAgrees: Array<[number, number]> = [
    [0.03, 350.5], // 1051.5 cents
    [0.41, 27.5], // 1127.5 cents
    [0.3, 123.45], // 3703.5 cents
    [0.01, 0.5], // 0.5 cents
  ];

  it.each(summaryAgrees)(
    'is priced in the unbilled summary at the same cents as the stored entry (%p h at $%p)',
    async (h, r) => {
      const entry = await logTime(h, r);
      const res = await owner.api.get(`${INV()}/unbilled-summary`);
      expect(res.status).toBe(200);
      const line = res.body.unbilledTimeEntries.find((e: any) => e.id === entry.id);
      expect(Math.round(line.amount * 100)).toBe(await storedCents(entry.id));
    },
  );

  it.each(resaveAgrees)(
    'keeps the invoice total equal to the stored entry when the lines are re-saved unchanged (%p h at $%p)',
    async (h, r) => {
      const entry = await logTime(h, r);
      const cents = await storedCents(entry.id);
      const created = await owner.api.post(INV()).send({
        invoiceName: `Time ${randomUUID().slice(0, 6)}`,
        invoiceDate: '2026-03-12',
        totalAmount: cents / 100,
        timeEntries: [{ id: entry.id, hours: h, rate: r, amount: cents / 100 }],
      });
      expect(created.status).toBe(201);
      const invoiceId = created.body.invoice.id;
      expect(Number((await testPool.query('select total_cents from invoices where id = $1', [invoiceId])).rows[0].total_cents)).toBe(cents);

      const edited = await owner.api.patch(`${INV()}/${invoiceId}/line-items`).send({
        timeEntries: [{ id: entry.id, hours: h, rate: r, amount: cents / 100 }],
        flatFees: [],
        expenses: [],
      });
      expect(edited.status).toBe(200);
      const after = (await testPool.query(
        `select total_cents, (select sum(amount_cents) from invoice_line_items where invoice_id = $1) as lines
           from invoices where id = $1`, [invoiceId],
      )).rows[0];
      expect(Number(after.total_cents)).toBe(cents);
      expect(Number(after.lines)).toBe(cents);
    },
  );

  it('sums line items to the invoice total for whole-cent products', async () => {
    const entries = [] as Array<{ id: string; cents: number; h: number; r: number }>;
    for (const [h, r] of [[2.0, 125], [1.5, 200], [0.75, 310]] as Array<[number, number]>) {
      const e = await logTime(h, r);
      entries.push({ id: e.id, cents: await storedCents(e.id), h, r });
    }
    const total = entries.reduce((s, e) => s + e.cents, 0);
    const created = await owner.api.post(INV()).send({
      invoiceName: 'Sum check',
      invoiceDate: '2026-03-12',
      totalAmount: total / 100,
      timeEntries: entries.map((e) => ({ id: e.id, hours: e.h, rate: e.r, amount: e.cents / 100 })),
    });
    expect(created.status).toBe(201);
    const row = (await testPool.query(
      `select total_cents, (select sum(amount_cents) from invoice_line_items where invoice_id = i.id) as lines
         from invoices i where id = $1`, [created.body.invoice.id],
    )).rows[0];
    expect(Number(row.total_cents)).toBe(total);
    expect(Number(row.lines)).toBe(total);
  });
});

describe('billing increments applied before the amount is generated', () => {
  /** Smallest whole number of increments covering `h` hundredths, in whole hundredths. */
  function billedHundredths(h: number, minutes: number): number {
    const steps = Math.ceil((3 * h) / (5 * minutes));
    return Math.ceil((steps * 5 * minutes) / 3);
  }

  async function setRounding(incrementMinutes: number) {
    const res = await testPool.query(
      `update law_firms set settings = jsonb_build_object('billing',
         jsonb_build_object('timeRounding', jsonb_build_object('enabled', true, 'incrementMinutes', $2::int)))
       where id = $1`,
      [firm.id, incrementMinutes],
    );
    expect(res.rowCount).toBe(1);
  }

  const cases = [6, 10, 12, 15, 30].flatMap((m) => [0.1, 0.11, 0.9, 0.01, 1.01].map((h) => [m, h]));
  it.each(cases)('on a %i-minute increment stores %p h as the covering increment and prices it exactly', async (minutes, h) => {
    await setRounding(minutes);
    const entry = await logTime(h, 300);
    const hundredths = billedHundredths(Math.round(h * 100), minutes);
    const row = (await testPool.query('select hours::text hours, amount_cents from activities where id = $1', [entry.id])).rows[0];
    expect(Math.round(Number(row.hours) * 100)).toBe(hundredths);
    expect(Number(row.amount_cents)).toBe(hundredths * 300);
    expect(Math.round(entry.amount * 100)).toBe(hundredths * 300);
  });
});
