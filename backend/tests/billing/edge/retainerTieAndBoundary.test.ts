/**
 * Retainer period boundaries and overage priced in integer cents.
 *
 * RED IF: an entry on the first or last day of a period lands in the neighbouring one, a
 * month-end anchored plan drifts off its anchor day, or an overage line stops being
 * `round(hours * rate_cents)` with the fee line and the invoice total summing to it.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const P = () => `/api/lawfirms/${firm.id}/billing/plans`;
const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;

async function logTime(hours: number, date: string, rate = 200, description = 'Work') {
  const res = await owner.api.post(T()).send({
    clientId: client.id, userId: owner.uid, hours, date, hourlyRate: rate, description,
  });
  expect(res.status).toBe(201);
  return res.body.timeEntry.id as string;
}
async function createPlan(includedHours: number, extra: Record<string, unknown> = {}) {
  const res = await owner.api.post(P()).send({
    contextType: 'client', entityId: client.id, name: 'Retainer', intervalUnit: 'month',
    startDate: '2026-03-01', amount: 500, includedHours, ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.plan.id as string;
}
const periodOf = async (planId: string, id = '2026-03-01') => {
  const res = await owner.api.get(P());
  return res.body.plans.find((p: any) => p.id === planId).periods.find((p: any) => p.id === id);
};
const draft = (planId: string, id = '2026-03-01') => owner.api.post(`${P()}/${planId}/periods/${id}/create-draft`).send({});

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Retainer Client', email: 'ret@example.test' });
  await drainEvents();
});

describe('period boundaries', () => {
  it('puts the last day of March in March and the first of April in April', async () => {
    const lastMarch = await logTime(1, '2026-03-31');
    const firstApril = await logTime(1, '2026-04-01');
    const planId = await createPlan(1);

    const march = await periodOf(planId, '2026-03-01');
    const april = await periodOf(planId, '2026-04-01');

    expect(march.periodEndDate).toBe('2026-03-31');
    expect(march.coveredTimeEntryIds).toEqual([lastMarch]);
    expect(april.coveredTimeEntryIds).toEqual([firstApril]);
    expect(march.overageHours).toBe(0);
    expect(april.overageHours).toBe(0);
  });

  it('puts the 29th, 30th and 31st anchored months on the right last days across February', async () => {
    const planId = await createPlan(0, { startDate: '2026-01-31' });
    const res = await owner.api.get(P());
    const periods = res.body.plans.find((p: any) => p.id === planId).periods
      .filter((p: any) => p.periodStartDate < '2026-05-01')
      .sort((a: any, b: any) => (a.periodStartDate < b.periodStartDate ? -1 : 1))
      .map((p: any) => [p.periodStartDate, p.periodEndDate]);

    expect(periods).toEqual([
      ['2026-01-31', '2026-02-27'],
      ['2026-02-28', '2026-03-30'],
      ['2026-03-31', '2026-04-29'],
      ['2026-04-30', '2026-05-30'],
    ]);
  });
});

describe('overage priced in integer cents', () => {
  it('bills the half-hour overage of a straddling entry at the exact cent and totals fee plus overage', async () => {
    const entry = await logTime(3, '2026-03-10', 111.11);
    const planId = await createPlan(2.5);

    const res = await draft(planId);

    expect(res.status).toBe(201);
    const lines = await testPool.query(
      `select kind, quantity::text as qty, amount_cents::int as cents from invoice_line_items
        where invoice_id = $1 order by kind`, [res.body.invoice.id]);
    // 0.5h x 11111 cents = 5555.5 -> 5556
    expect(lines.rows).toEqual([
      { kind: 'flat_fee', qty: null, cents: 50_000 },
      { kind: 'time_entry', qty: '0.5', cents: 5_556 },
    ]);
    const inv = await testPool.query('select total_cents::int as total from invoices where id = $1', [res.body.invoice.id]);
    expect(inv.rows[0].total).toBe(55_556);
    expect(entry).toBeTruthy();
  });
});
