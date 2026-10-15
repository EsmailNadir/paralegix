/**
 * Splitting one matter's bill between payers, in exact cents.
 *
 * The amount of each source line is the one the unbilled summary reports for
 * it, which is what the composer and the bulk run bill from, and every
 * expectation is an integer sum over those cents. The allocation arithmetic
 * under test is never called here to produce an oracle.
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
let clients: ClientRecord[];

const BULK = () => `/api/lawfirms/${firm.id}/billing/invoices/bulk`;
const SPLIT = (matterId: string) => `/api/lawfirms/${firm.id}/billing/invoices/matter/${matterId}/split`;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedMatter(payerBps: Array<{ client: ClientRecord; bp: number | null }>) {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, 'Split matter', $3, 'active')`,
    [id, firm.id, `REF-${id.slice(0, 8)}`],
  );
  await testPool.query(
    `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at) values ($1, $2, $3, 'lead', now())`,
    [id, owner.uid, firm.id],
  );
  for (const { client, bp } of payerBps) {
    await testPool.query(
      `insert into matter_clients (matter_id, client_id, law_firm_id, billing_portion_bp) values ($1, $2, $3, $4)`,
      [id, client.id, firm.id, bp],
    );
  }
  return id;
}

async function seedTime(matterId: string, hundredths: number, rateCents: number) {
  const id = randomUUID();
  await testPool.query(
    `insert into activities (kind, id, law_firm_id, matter_id, user_id, activity_date, hours, rate_cents, description)
     values ('time', $1, $2, $3, $4, date '2026-03-10', $5, $6, 'Work')`,
    [id, firm.id, matterId, owner.uid, (hundredths / 100).toFixed(2), rateCents],
  );
  return id;
}

async function seedFee(matterId: string, cents: number) {
  const id = randomUUID();
  await testPool.query(
    `insert into activities (kind, id, law_firm_id, matter_id, description, charge_cents, activity_date)
     values ('flat_fee', $1, $2, $3, 'Fee', $4, date '2026-03-10')`,
    [id, firm.id, matterId, cents],
  );
  return id;
}

async function invoicesOf(matterId: string) {
  const { rows } = await testPool.query(
    `select id, client_id, total_cents, total_hours, tax_cents,
            (select coalesce(sum(amount_cents), 0) from invoice_line_items where invoice_id = i.id) as lines
       from invoices i where matter_id = $1 order by invoice_number`,
    [matterId],
  );
  return rows.map((r: any) => ({
    id: r.id as string,
    clientId: r.client_id as string,
    total: Number(r.total_cents),
    hours: Number(r.total_hours),
    tax: Number(r.tax_cents),
    lines: Number(r.lines),
  }));
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  clients = [];
  for (let i = 0; i < 6; i += 1) clients.push(await createPersonClient(firm.id, { name: `Payer ${i}` }));
  await drainEvents();
});

describe('automatic split by matter portions (bulk run)', () => {
  it('reconciles to the exact source cents on 40 seeded matters with 2-6 payers', async () => {
    const rand = mulberry32(20261003);
    for (let round = 0; round < 40; round += 1) {
      const n = 2 + Math.floor(rand() * 5);
      const cuts = Array.from({ length: n - 1 }, () => 1 + Math.floor(rand() * 9_998)).sort((a, b) => a - b);
      const bounds = [0, ...cuts, 10_000];
      const bps = bounds.slice(1).map((b, i) => b - bounds[i]).filter((p) => p > 0);
      const payers = bps.map((bp, i) => ({ client: clients[i], bp }));
      const matterId = await seedMatter(payers);

      const sources: string[] = [];
      const timeCount = 1 + Math.floor(rand() * 5);
      for (let k = 0; k < timeCount; k += 1) {
        // 0.01h to 8.00h at 1 cent to $999.99 an hour.
        sources.push(await seedTime(matterId, 1 + Math.floor(rand() * 800), 1 + Math.floor(rand() * 99_999)));
      }
      for (let k = 0; k < Math.floor(rand() * 3); k += 1) {
        sources.push(await seedFee(matterId, 1 + Math.floor(rand() * 500_000)));
      }
      // The billable amount of each source as the unbilled summary prices it
      // (what the composer and the bulk run both bill from).
      const summary = await owner.api.get(`/api/lawfirms/${firm.id}/billing/invoices/matter/${matterId}/unbilled-summary`);
      const lines = [...summary.body.unbilledTimeEntries, ...summary.body.unbilledFlatFees] as any[];
      const amounts = new Map(lines.map((l) => [l.id as string, { cents: Math.round(l.amount * 100), hours: l.hours ?? 0 }]));
      expect(amounts.size).toBe(sources.length);
      const sourceTotal = [...amounts.values()].reduce((s, v) => s + v.cents, 0);
      const sourceHours = [...amounts.values()].reduce((s, v) => s + Math.round(v.hours * 100), 0);

      const res = await owner.api.post(BULK()).send({
        invoiceDate: '2026-03-15', contexts: [{ type: 'matter', entityId: matterId }],
      });
      const label = { round, n, bps, sourceTotal };
      if (res.status !== 201 || res.body.failed.length > 0) {
        // A payer whose share of a tiny bill is zero cents is refused by the
        // split guard; that is a refusal, not a reconciliation failure.
        expect({ ...label, errors: res.body.errors }).toEqual(expect.objectContaining({ errors: expect.anything() }));
        const only = Object.values(res.body.errors as Record<string, string>).join(' ');
        expect(only).toMatch(/positive total/);
        continue;
      }

      const invoices = await invoicesOf(matterId);
      expect({ ...label, count: invoices.length }).toEqual({ ...label, count: n });
      expect({ ...label, sum: invoices.reduce((s, i) => s + i.total, 0) })
        .toEqual({ ...label, sum: sourceTotal });
      expect({ ...label, hours: invoices.reduce((s, i) => s + Math.round(i.hours * 100), 0) })
        .toEqual({ ...label, hours: sourceHours });
      invoices.forEach((inv) => expect({ ...label, id: inv.id, lines: inv.lines }).toEqual({ ...label, id: inv.id, lines: inv.total }));

      // Each source line, summed across the payers' invoices, is that source's cents.
      const { rows } = await testPool.query(
        `select l.source_id, sum(l.amount_cents)::bigint as cents
           from invoice_line_items l join invoices i on i.id = l.invoice_id
          where i.matter_id = $1 group by l.source_id`, [matterId],
      );
      expect(rows).toHaveLength(sources.length);
      rows.forEach((r: any) => {
        expect({ ...label, source: r.source_id, cents: Number(r.cents) })
          .toEqual({ ...label, source: r.source_id, cents: amounts.get(r.source_id)!.cents });
      });
    }
  }, 120_000);

  it('gives a 100.00 flat fee to three equal payers as 33.33 + 33.33 + 33.34 to the cent', async () => {
    const matterId = await seedMatter([
      { client: clients[0], bp: 3334 }, { client: clients[1], bp: 3333 }, { client: clients[2], bp: 3333 },
    ]);
    await seedFee(matterId, 10_000);
    const res = await owner.api.post(BULK()).send({ invoiceDate: '2026-03-15', contexts: [{ type: 'matter', entityId: matterId }] });
    expect(res.status).toBe(201);
    const totals = (await invoicesOf(matterId)).map((i) => i.total).sort((a, b) => a - b);
    expect(totals.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(totals).toEqual([3333, 3333, 3334]);
  });
});

describe('explicit split by amount', () => {
  async function flatFeeMatter(cents: number, payers: number) {
    const matterId = await seedMatter(clients.slice(0, payers).map((client) => ({ client, bp: null })));
    const feeId = await seedFee(matterId, cents);
    return { matterId, feeId };
  }

  function request(matterId: string, feeId: string, shareCents: number[], total: number) {
    return owner.api.post(SPLIT(matterId)).send({
      invoiceDate: '2026-03-15',
      splitMode: 'fixed_amount',
      sourceSelection: { timeEntries: [], flatFees: [feeId] },
      invoices: shareCents.map((c, i) => ({
        matterClientId: clients[i].id,
        invoiceName: `Share ${i} ${randomUUID().slice(0, 5)}`,
        totalAmount: c / 100,
        totalHours: 0,
        flatFeesAmount: c / 100,
        flatFees: [{ id: feeId, description: 'Fee', amount: c / 100, allocationAmount: c / 100, allocationPercent: (c / total) * 100 }],
      })),
    });
  }

  it.each([
    [10_000, [3333, 3333, 3334]],
    [10_001, [5000, 5001]],
    [100_000_000, [16_666_666, 16_666_666, 16_666_666, 16_666_666, 16_666_666, 16_666_670]],
    [299_999_999_997, [99_999_999_999, 99_999_999_999, 99_999_999_999]],
  ])('accepts %p cents split as %j and stores each share exactly', async (total, shares) => {
    const { matterId, feeId } = await flatFeeMatter(total, shares.length);
    const res = await request(matterId, feeId, shares, total);
    expect(res.status).toBe(201);
    const stored = (await invoicesOf(matterId)).map((i) => i.total).sort((a, b) => a - b);
    expect(stored).toEqual([...shares].sort((a, b) => a - b));
    expect(stored.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it.each([
    [10_000, [3333, 3333, 3333]], // 99.99: a cent lost
    [10_000, [3334, 3334, 3333]], // 100.01: a cent invented
    [10_001, [5001, 5001]], // 100.02
    [10_001, [5000, 5000]], // 100.00
  ])('refuses %p cents split as %j because the shares do not add up', async (total, shares) => {
    const { matterId, feeId } = await flatFeeMatter(total, shares.length);
    const res = await request(matterId, feeId, shares, total);
    expect(res.status).toBe(400);
    expect(await invoicesOf(matterId)).toHaveLength(0);
  });
});
