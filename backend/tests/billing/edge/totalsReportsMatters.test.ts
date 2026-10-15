/**
 * Billing reports, matter balances and the daily digest against the ledger.
 *
 * RED IF: a report row sums a voided invoice, mis-attributes an invoice to the
 * wrong client or matter, loses a cent of an uneven split, lists a matter with
 * nothing on it, or a matter's outstanding or billed figure drifts from its
 * invoices.
 */
import { testPool } from '../../support/setupInProcess';
import { buildWorld, remainingOf, sum, apiRoot, type World, type Entry } from './totalsWorld';
import { readReports, cents, owing } from './totalsSurfaces';
import { findDigestInvoices } from '../../../src/modules/notifications/digest/digest.repository';

let w: World;

beforeEach(async () => {
  w = await buildWorld();
});

const rowFor = (rows: any[], name: string) => rows.find((r) => r.name === name);

/** The earliest day a payment is expected on any of these invoices that still owe. */
const nextDay = (es: Entry[]) =>
  es.filter((e) => !e.voided && remainingOf(e) > 0 && e.dueDay).map((e) => e.dueDay as string).sort()[0] ?? null;

describe('billing by client', () => {
  const forClient = (key: string) => w.ledger.filter((e) => e.clientId === w.clients[key]);

  it.each([['main', 'Main Client'], ['idle', 'Idle Client'], ['person', 'Linked Person'], ['org', 'Org Holdings'],
    ['split1', 'Split One'], ['split2', 'Split Two'], ['split3', 'Split Three']])(
    '%s: invoice count includes the voided one, billed and outstanding do not',
    async (key, name) => {
      const es = forClient(key);
      const { byClient } = await readReports(w);

      const row = rowFor(byClient.rows, name);

      expect(row.invoiceCount).toBe(es.length);
      expect(cents(row.totalBilled)).toBe(sum(es.filter((e) => !e.voided), (e) => e.totalCents));
      expect(cents(row.totalOutstanding)).toBe(sum(es, remainingOf));
      expect(row.nextPaymentDate).toBe(nextDay(es));
    },
  );

  it('the three uneven split shares add up to the 100.00 that was split', async () => {
    const { byClient } = await readReports(w);

    const shares = ['Split One', 'Split Two', 'Split Three'].map((n) => cents(rowFor(byClient.rows, n).totalBilled));

    expect(shares).toEqual([3334, 3333, 3333]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it('rows plus the unattributed line cover every invoice, so the firm total never moves between groupings', async () => {
    const { byClient } = await readReports(w);

    const counted = byClient.rows.reduce((s: number, r: any) => s + r.invoiceCount, 0) + byClient.unattributedInvoices.count;
    expect(counted).toBe(w.ledger.length);
    expect(byClient.totalItems).toBe(byClient.rows.length);
  });

  it('pages of two return every client once with the same total on each page', async () => {
    const whole = (await readReports(w)).byClient.rows.map((r: any) => r.id);
    const seen: string[] = [];
    const totals: number[] = [];
    for (let page = 1; page < 20; page += 1) {
      const res = await w.owner.api.get(`${apiRoot(w)}/billing/reports/by-client?limit=2&page=${page}`);
      expect(res.status).toBe(200);
      totals.push(res.body.totalItems);
      seen.push(...res.body.rows.map((r: any) => r.id));
      if (res.body.rows.length < 2) break;
    }

    expect(new Set(totals)).toEqual(new Set([whole.length]));
    expect(seen).toEqual(whole);
  });

  it('a client with no invoices and no time is not listed', async () => {
    // Every client in the world has an invoice, so add one that has nothing.
    const created = await w.owner.api.post(`${apiRoot(w)}/clients`).send({ name: 'Nothing Client', clientType: 'person' });
    expect([200, 201]).toContain(created.status);

    const { byClient } = await readReports(w);

    expect(rowFor(byClient.rows, 'Nothing Client')).toBeUndefined();
  });
});

describe('billing by matter', () => {
  it('each matter states its invoice count, billed, outstanding and next payment from its own invoices', async () => {
    const { byMatter } = await readReports(w);

    for (const [key, name] of [['main', 'Main Matter'], ['split', 'Split Matter']]) {
      const es = w.ledger.filter((e) => e.matterId === w.matters[key]);
      const row = rowFor(byMatter.rows, name);
      expect(row.invoiceCount).toBe(es.length);
      expect(cents(row.totalBilled)).toBe(sum(es.filter((e) => !e.voided), (e) => e.totalCents));
      expect(cents(row.totalOutstanding)).toBe(sum(es, remainingOf));
      expect(row.nextPaymentDate).toBe(nextDay(es));
    }
  });

  it('lists no row for a matter that has no invoices and no time', async () => {
    const { byMatter } = await readReports(w);

    expect(rowFor(byMatter.rows, 'Empty Matter')).toBeUndefined();
    expect(byMatter.rows).toHaveLength(2);
  });

  it('states every invoice on no matter as the unlinked line, voided ones left out of the money', async () => {
    const { byMatter } = await readReports(w);
    const unlinked = w.ledger.filter((e) => e.matterId === null && !e.voided);

    expect(byMatter.unlinkedInvoices.count).toBe(unlinked.length);
    expect(cents(byMatter.unlinkedInvoices.totalAmount)).toBe(sum(unlinked, (e) => e.totalCents));
  });

  it('matter rows plus the unlinked line add up to everything ever billed', async () => {
    const { byMatter } = await readReports(w);
    const billed = byMatter.rows.reduce((s: number, r: any) => s + cents(r.totalBilled), 0)
      + cents(byMatter.unlinkedInvoices.totalAmount);

    expect(billed).toBe(sum(w.ledger.filter((e) => !e.voided), (e) => e.totalCents));
  });

  it("the client-by-matter breakdown for a client equals that client's matter invoices", async () => {
    const res = await w.owner.api.get(`${apiRoot(w)}/billing/reports/by-client/${w.clients.main}/matters`);
    expect(res.status).toBe(200);
    const es = w.ledger.filter((e) => e.clientId === w.clients.main && e.matterId === w.matters.main);
    const row = rowFor(res.body.matters, 'Main Matter');

    expect(res.body.totalItems).toBe(res.body.matters.length);
    expect(row.invoiceCount).toBe(es.length);
    expect(cents(row.billed)).toBe(sum(es, (e) => e.totalCents));
    expect(cents(row.outstanding)).toBe(sum(es, remainingOf));
  });
});

describe('matter balances', () => {
  const detail = async (key: string) => (await w.owner.api.get(`${apiRoot(w)}/matters/${w.matters[key]}`)).body;
  const listed = async () => (await w.owner.api.get(`${apiRoot(w)}/matters?limit=100`)).body.matters as any[];

  it.each([['main', 'Main Matter'], ['split', 'Split Matter'], ['empty', 'Empty Matter']])(
    '%s: outstanding and billed to date equal the matter invoices, in cents',
    async (key) => {
      const es = w.ledger.filter((e) => e.matterId === w.matters[key]);
      const d = await detail(key);
      const row = (await listed()).find((m) => m.id === w.matters[key]);

      expect(d.outstandingBalanceCents).toBe(sum(es, remainingOf));
      expect(d.billedTotalCents).toBe(sum(es.filter((e) => !e.voided), (e) => e.totalCents));
      expect(row.outstandingBalanceCents).toBe(d.outstandingBalanceCents);
    },
  );

  it('the split matter keeps all 100.00 across its three shares', async () => {
    expect((await detail('split')).billedTotalCents).toBe(10_000);
  });

  it('payment-ongoing follows the balance on a closed matter and clears when it is paid off', async () => {
    await testPool.query(`update matters set status = 'closed', close_date = current_date where id = $1`, [w.matters.main]);
    expect((await detail('main')).paymentOngoing).toBe(true);

    const e = w.ledger.find((x) => x.key === 'matterBilled')!;
    const pay = await w.owner.api.put(`${apiRoot(w)}/billing/invoices/matter/${w.matters.main}/${e.id}/payment`)
      .send({ paymentAmount: 777.77 });
    expect(pay.status).toBe(200);

    const after = await detail('main');
    expect(after.outstandingBalanceCents).toBe(0);
    expect(after.paymentOngoing).toBe(false);
  });
});

describe('matter list filter', () => {
  it('payment-ongoing returns exactly the closed matters that still owe, with a matching total', async () => {
    await testPool.query(
      `update matters set status = 'closed', close_date = current_date where id = any($1::uuid[])`,
      [[w.matters.main, w.matters.split, w.matters.empty]],
    );

    const res = await w.owner.api.get(`${apiRoot(w)}/matters?paymentOngoing=true&limit=100`);

    expect(res.status).toBe(200);
    // main and split owe money; empty has no invoices, so it is closed and settled.
    expect(res.body.matters.map((m: any) => m.name).sort()).toEqual(['Main Matter', 'Split Matter']);
    expect(res.body.totalItems).toBe(2);
  });
});

describe('daily digest', () => {
  it('lists every invoice with a balance due within the window, at its balance in cents', async () => {
    const lines = await findDigestInvoices(w.firm.id, w.day(0), w.day(7));
    // Every unpaid invoice is dated by the day a payment is next expected: its due date,
    // or its next instalment day when a plan governs it.
    const want = owing(w).filter((e) => e.dueDay !== null && e.dueDay >= w.day(-30) && e.dueDay <= w.day(7));
    const byId = new Map<string, number>(lines.map((l: any) => [l.id, l.amountCents]));

    expect(want.map((e) => e.key).sort()).toEqual(['due7', 'dueToday', 'dueTomorrow', 'dueYesterday', 'lateFee', 'orgOverdue', 'planLate']);
    for (const e of want) expect([e.key, byId.get(e.id)]).toEqual([e.key, remainingOf(e)]);
    expect(lines.map((l: any) => l.id).sort()).toEqual(want.map((e) => e.id).sort());
  });

  it('leaves out settled, zero-total, voided and undated invoices', async () => {
    const lines = await findDigestInvoices(w.firm.id, w.day(-60), w.day(60));
    const ids = new Set(lines.map((l: any) => l.id));

    for (const key of ['paid', 'credited', 'remainderOff', 'stripePaid', 'zero', 'zeroLate', 'voided', 'noDue']) {
      expect([key, ids.has(w.ledger.find((e) => e.key === key)!.id)]).toEqual([key, false]);
    }
  });
});
