/**
 * Retainer plan lifecycle: when a period opens in the firm's timezone, weekly
 * periods across a DST change, end dates, paused plans and a payer removed from
 * the matter.
 *
 * RED IF: a period opens on the UTC day instead of the firm's day, a weekly period
 * stretches or shrinks across the spring-forward week, a dated plan keeps minting
 * periods after its end date, a paused plan mints periods, or a draft for a matter
 * plan whose payer left the matter writes an invoice or moves the period.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, freezeClockAt, unfreezeClock,
  type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';
import { seedMatter } from '../../support/matters';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const P = () => `/api/lawfirms/${firm.id}/billing/plans`;

const setFirmZone = (zone: string) => testPool.query(
  `update law_firms set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('timezone', $2::text) where id = $1`,
  [firm.id, zone]);

async function createPlan(extra: Record<string, unknown> = {}) {
  const res = await owner.api.post(P()).send({
    contextType: 'client', entityId: client.id, name: 'Retainer', intervalUnit: 'month',
    startDate: '2026-03-01', amount: 500, includedHours: 1, ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.plan as any;
}
const starts = async (planId: string) => {
  const res = await owner.api.get(P());
  expect(res.status).toBe(200);
  return res.body.plans.find((p: any) => p.id === planId).periods
    .map((p: any) => p.periodStartDate).sort();
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Lifecycle Client', email: 'life@example.test' });
  await drainEvents();
});
afterEach(() => unfreezeClock());

describe('a period opens on the firm day', () => {
  it('has not opened April at 22:00 on March 31 in New York, though it is April 1 in UTC', async () => {
    await setFirmZone('America/New_York');
    freezeClockAt('2026-04-01T02:00:00Z');
    const plan = await createPlan();

    expect(await starts(plan.id)).toEqual(['2026-03-01']);
  });

  it('opens April at 01:00 on April 1 in New York', async () => {
    await setFirmZone('America/New_York');
    freezeClockAt('2026-04-01T05:00:00Z');
    const plan = await createPlan();

    expect(await starts(plan.id)).toEqual(['2026-03-01', '2026-04-01']);
  });

  it('opens April at 01:30 on April 1 in Auckland, while it is still March 31 in UTC', async () => {
    await setFirmZone('Pacific/Auckland');
    freezeClockAt('2026-03-31T12:30:00Z');
    const plan = await createPlan();

    expect(await starts(plan.id)).toEqual(['2026-03-01', '2026-04-01']);
  });
});

describe('weekly periods across the US spring-forward week', () => {
  it('stay seven calendar days each', async () => {
    await setFirmZone('America/New_York');
    freezeClockAt('2026-03-24T16:00:00Z');
    const plan = await createPlan({ intervalUnit: 'week', startDate: '2026-03-02' });
    const res = await owner.api.get(P());
    const periods = res.body.plans.find((p: any) => p.id === plan.id).periods
      .sort((a: any, b: any) => (a.periodStartDate < b.periodStartDate ? -1 : 1))
      .map((p: any) => [p.periodStartDate, p.periodEndDate]);

    expect(periods).toEqual([
      ['2026-03-02', '2026-03-08'],
      ['2026-03-09', '2026-03-15'],
      ['2026-03-16', '2026-03-22'],
      ['2026-03-23', '2026-03-29'],
    ]);
  });
});

describe('end date and pause', () => {
  it('mints no period starting after the end date', async () => {
    freezeClockAt('2026-08-15T16:00:00Z');
    const plan = await createPlan({ endCondition: 'date', endDate: '2026-05-15' });

    expect(await starts(plan.id)).toEqual(['2026-03-01', '2026-04-01', '2026-05-01']);
  });

  it('mints no period while paused and resumes from where it stopped', async () => {
    freezeClockAt('2026-03-15T16:00:00Z');
    const plan = await createPlan();
    expect(await starts(plan.id)).toEqual(['2026-03-01']);
    const paused = await owner.api.put(`${P()}/${plan.id}`).send({ status: 'paused' });
    expect(paused.status).toBe(200);

    freezeClockAt('2026-06-15T16:00:00Z');
    expect(await starts(plan.id)).toEqual(['2026-03-01']);

    const resumed = await owner.api.put(`${P()}/${plan.id}`).send({ status: 'active' });
    expect(resumed.status).toBe(200);
    expect(await starts(plan.id)).toEqual(['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01']);
  });
});

describe('a matter plan whose payer left the matter', () => {
  it('refuses the draft with a 400 and leaves the period ready to bill and no invoice written', async () => {
    const matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
    const plan = await createPlan({ contextType: 'matter', entityId: matterId, defaultClientId: client.id });
    await testPool.query('delete from matter_clients where matter_id = $1 and client_id = $2', [matterId, client.id]);

    const res = await owner.api.post(`${P()}/${plan.id}/periods/2026-03-01/create-draft`).send({});

    expect(res.status).toBe(400);
    const invoices = await testPool.query('select count(*)::int as n from invoices where law_firm_id = $1', [firm.id]);
    expect(invoices.rows[0].n).toBe(0);
    const period = await testPool.query(
      `select status, generated_invoice_id from billing_plan_periods where billing_plan_id = $1 and period_start_date = '2026-03-01'`,
      [plan.id]);
    expect(period.rows[0]).toEqual({ status: 'ready_to_bill', generated_invoice_id: null });
  });
});

describe('drawing one period twice', () => {
  it('writes a single invoice and links the period once when two drafts race', async () => {
    const plan = await createPlan({ includedHours: 0 });
    const draft = () => owner.api.post(`${P()}/${plan.id}/periods/2026-03-01/create-draft`).send({});

    const results = await Promise.all([draft(), draft(), draft()]);

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 201).every((r) => r.status === 400)).toBe(true);
    const invoices = await testPool.query(
      `select id, total_cents::int as total from invoices where law_firm_id = $1`, [firm.id]);
    expect(invoices.rows).toHaveLength(1);
    expect(invoices.rows[0].total).toBe(50_000);
    const period = await testPool.query(
      `select status, generated_invoice_id from billing_plan_periods where billing_plan_id = $1 and period_start_date = '2026-03-01'`,
      [plan.id]);
    expect(period.rows[0]).toEqual({ status: 'draft_created', generated_invoice_id: invoices.rows[0].id });
  });
});
