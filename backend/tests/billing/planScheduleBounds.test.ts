/**
 * How far a retainer's schedule may reach, and how much one read may generate.
 *
 * `nextRunDate` is the generator's cursor and every read walks it up to today,
 * one period per interval. A 1900 start date made a single request write
 * thousands of periods. The dates are bounded at the route, and the walk itself
 * is capped per pass for any row the route did not write.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  freezeClockAt,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { MAX_PERIODS_PER_PASS } from '../../src/modules/billing/plans/plans.service';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const P = () => `/api/lawfirms/${firm.id}/billing/plans`;

const createPlan = (overrides: Record<string, unknown> = {}) => owner.api.post(P()).send({
  contextType: 'client', entityId: client.id, name: 'Retainer', intervalUnit: 'month',
  startDate: '2026-03-01', amount: 500, ...overrides,
});

const planCount = async () => Number((await testPool.query(
  'select count(*)::int n from billing_plans where law_firm_id = $1', [firm.id],
)).rows[0].n);

const periodCount = async (planId: string) => Number((await testPool.query(
  'select count(*)::int n from billing_plan_periods where billing_plan_id = $1', [planId],
)).rows[0].n);

const planDates = async (planId: string) => (await testPool.query(
  'select start_date, next_run_date from billing_plans where id = $1', [planId],
)).rows[0];

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Schedule Client' });
  await drainEvents();
});

describe('the start date is bounded', () => {
  /** Red if the floor is removed: 1900 is accepted and ~1,500 periods are written. */
  it('refuses a 1900 start date and writes no plan', async () => {
    const res = await createPlan({ startDate: '1900-01-01' });

    expect(res.status).toBe(400);
    expect(await planCount()).toBe(0);
  });

  /** Boundary: the day before the floor is refused, the floor itself is accepted. */
  it('refuses 1999-12-31 and accepts 2000-01-01 with one period per month since', async () => {
    freezeClockAt('2026-06-15T12:00:00Z');

    expect((await createPlan({ startDate: '1999-12-31' })).status).toBe(400);
    const ok = await createPlan({ startDate: '2000-01-01' });

    expect(ok.status).toBe(201);
    // January 2000 through June 2026 inclusive: 26 * 12 + 6.
    expect(await periodCount(ok.body.plan.id)).toBe(318);
  });

  /** Red if `nextRunDate` (the actual cursor) is left unbounded. */
  it('refuses a 1900 nextRunDate even with a valid start date', async () => {
    const res = await createPlan({ startDate: '2026-03-01', nextRunDate: '1900-01-01' });

    expect(res.status).toBe(400);
    expect(await planCount()).toBe(0);
  });

  /** Boundary on the far side: exactly five years ahead is allowed, one day more is not. */
  it('accepts a start five years ahead and refuses one day further', async () => {
    freezeClockAt('2026-06-15T12:00:00Z');

    const ok = await createPlan({ startDate: '2031-06-15' });
    expect(ok.status).toBe(201);
    expect(await periodCount(ok.body.plan.id)).toBe(0);

    const tooFar = await createPlan({ startDate: '2031-06-16' });
    expect(tooFar.status).toBe(400);
    expect(await planCount()).toBe(1);
  });

  /** Red if the schema goes back to `union([string, number])`. */
  it.each([
    ['a number', 1717000000000],
    ['an impossible day', '2026-02-30'],
    ['a timestamp', '2026-03-01T00:00:00Z'],
  ])('refuses %s as a start date', async (_label, startDate) => {
    const res = await createPlan({ startDate });

    expect(res.status).toBe(400);
    expect(await planCount()).toBe(0);
  });

  /** Red if `endDate` reaches the `date` column unchecked (was a 500). */
  it('refuses a malformed end date with a 400, not a 500', async () => {
    const res = await createPlan({ endCondition: 'date', endDate: 'next spring' });

    expect(res.status).toBe(400);
    expect(await planCount()).toBe(0);
  });

  /** The update path carries the same bound. Red if only create is fixed. */
  it('refuses a 1900 start date on update and leaves the plan alone', async () => {
    const created = await createPlan({ startDate: '2026-03-01' });
    expect(created.status).toBe(201);

    const res = await owner.api.put(`${P()}/${created.body.plan.id}`).send({ startDate: '1900-01-01' });

    expect(res.status).toBe(400);
    expect((await planDates(created.body.plan.id)).start_date).toBe('2026-03-01');
  });
});

describe('the generator', () => {
  /**
   * Regression for the legitimate long backfill: two years of weekly periods
   * come out complete and contiguous. Red if the cap is set too low or the
   * loop stops early.
   */
  it('generates every week of a plan started two years ago', async () => {
    freezeClockAt('2026-06-15T12:00:00Z');

    const res = await createPlan({ intervalUnit: 'week', startDate: '2024-06-17' });

    expect(res.status).toBe(201);
    const planId = res.body.plan.id;
    expect(await periodCount(planId)).toBe(105);
    const { rows } = await testPool.query(
      `select max(period_start_date) as last from billing_plan_periods where billing_plan_id = $1`,
      [planId],
    );
    expect(rows[0].last).toBe('2026-06-15');
    expect((await planDates(planId)).next_run_date).toBe('2026-06-22');
  });

  /**
   * The cap, reached through a row the route could never have accepted. Red if
   * the loop is unbounded (the first read writes ~6,600 periods) or if a capped
   * pass forgets where it stopped (the second read would write nothing).
   */
  it('writes at most MAX_PERIODS_PER_PASS periods per read and resumes on the next', async () => {
    expect(MAX_PERIODS_PER_PASS).toBe(500);
    const planId = randomUUID();
    await testPool.query(
      `insert into billing_plans
         (id, law_firm_id, client_id, plan_type, name, status, interval_unit, interval_count,
          start_date, next_run_date, amount_cents, included_hours)
       values ($1, $2, $3, 'retainer', 'Legacy', 'active', 'week', 1,
               '1900-01-01', '1900-01-01', 10000, 0)`,
      [planId, firm.id, client.id],
    );

    expect((await owner.api.get(P())).status).toBe(200);
    expect(await periodCount(planId)).toBe(500);
    // 1900-01-01 plus 500 weeks.
    expect((await planDates(planId)).next_run_date).toBe('1909-08-02');

    expect((await owner.api.get(P())).status).toBe(200);
    expect(await periodCount(planId)).toBe(1000);
  });
});
