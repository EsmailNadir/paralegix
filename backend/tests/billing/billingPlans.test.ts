/**
 * Evergreen retainer plans, which bill a client on a schedule.
 *
 * `plans.service.ts` was at 10% and its repository at 5%. A plan is the one
 * billing object that produces invoices without anyone pressing a button, so a
 * mistake here bills a client the wrong amount, on the wrong day, repeatedly,
 * and nobody is looking at the moment it happens.
 *
 * ONE THING TO KNOW BEFORE READING: a period's id is its START DATE, not the
 * uuid of its `billing_plan_periods` row. The service says so at
 * `createDraftFromPeriod`, and `findPeriodById` takes `periodStartDate`. The row
 * uuid looks like the obvious identifier and is the wrong one, which is worth
 * stating because it cost a 500 to discover (covered below).
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  createOrgClient,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { freezeClockAt } from '../support/clock';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const P = () => `/api/lawfirms/${firm.id}/billing/plans`;

async function createPlan(overrides: Record<string, unknown> = {}) {
  return owner.api.post(P()).send({
    contextType: 'client',
    entityId: client.id,
    name: 'Monthly Retainer',
    intervalUnit: 'month',
    startDate: '2026-03-01',
    amount: 500,
    includedHours: 5,
    ...overrides,
  });
}

const planRow = async (id: string) => {
  const { rows } = await testPool.query(
    'select name, amount_cents, interval_unit, interval_count, status, included_hours from billing_plans where id = $1',
    [id],
  );
  return rows[0];
};

const periods = async () => {
  const { rows } = await testPool.query(
    `select period_start_date, period_end_date, status, amount_cents
       from billing_plan_periods where law_firm_id = $1 order by period_start_date`,
    [firm.id],
  );
  return rows;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Retainer Client' });
  await drainEvents();
});

describe('creating a plan', () => {
  it('creates one and returns it', async () => {
    const res = await createPlan();

    expect(res.status).toBe(201);
    expect(res.body.plan.id).toBeTruthy();
  });

  it('stores the amount in integer CENTS', async () => {
    const res = await createPlan({ amount: 500 });

    // $500.00 is 50000 cents. Storing 500 would bill the client five dollars a
    // month, every month, until someone noticed.
    expect(Number((await planRow(res.body.plan.id)).amount_cents)).toBe(50_000);
  });

  it('keeps a fractional amount exact', async () => {
    const res = await createPlan({ amount: 1234.56 });

    expect(Number((await planRow(res.body.plan.id)).amount_cents)).toBe(123_456);
  });

  it('starts the plan active', async () => {
    const res = await createPlan();

    // A plan created paused would never bill, and the firm would find out a
    // month later.
    expect((await planRow(res.body.plan.id)).status).toBe('active');
  });

  it('accepts an ORGANIZATION as the billed party', async () => {
    const org = await createOrgClient(firm.id, { name: 'Acme Corporation' });
    await drainEvents();

    const res = await createPlan({ entityId: org.id, name: 'Corporate Retainer' });

    // A corporate retainer is the common case for this feature. A path that
    // resolved the client through `clients.user_id`, which an organization can
    // never carry, refuses here.
    expect(res.status).toBe(201);
  });

  it('refuses a zero or negative amount', async () => {
    expect((await createPlan({ amount: 0 })).status).toBe(400);
    expect((await createPlan({ amount: -5 })).status).toBe(400);
  });

  it('accepts an amount right at the documented maximum', async () => {
    const res = await createPlan({ amount: 1_000_000_000 });

    expect(res.status).toBe(201);
    expect(Number((await planRow(res.body.plan.id)).amount_cents)).toBe(100_000_000_000);
  });

  it('rejects an amount one dollar past the documented maximum', async () => {
    const res = await createPlan({ amount: 1_000_000_001 });

    // Rejecting max+1 on this field also rejects anything larger, such as 1e17,
    // whose cents overflow a bigint and used to answer 500 from the insert.
    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      'select count(*)::int as n from billing_plans where law_firm_id = $1', [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('refuses an unknown interval unit', async () => {
    const res = await createPlan({ intervalUnit: 'fortnight' });

    // The interval decides how often a client is charged. An unrecognised value
    // that fell through to a default would bill on a schedule nobody chose.
    expect(res.status).toBe(400);
  });

  it('refuses a plan with no name', async () => {
    const res = await createPlan({ name: '' });

    expect(res.status).toBe(400);
  });

  it('refuses a client that belongs to ANOTHER firm', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/billing/plans`)
      .send({
        contextType: 'client', entityId: client.id, name: 'Foreign Retainer',
        intervalUnit: 'month', startDate: '2026-03-01', amount: 500,
      });

    // A recurring charge against a client the firm does not have would bill
    // nobody, forever.
    expect(res.status).toBe(404);
  });

  it('refuses a member without the invoice permission', async () => {
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.post(P()).send({
      contextType: 'client', entityId: client.id, name: 'Sneaky Retainer',
      intervalUnit: 'month', startDate: '2026-03-01', amount: 500,
    });

    expect(res.status).toBe(403);
  });
});

describe('the schedule it generates', () => {
  it('lays out consecutive periods from the start date', async () => {
    await createPlan({ startDate: '2026-03-01', intervalUnit: 'month' });

    const rows = await periods();
    // A retainer's whole value is that the periods exist before anyone thinks
    // about them. Generating none would make the plan inert.
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0].period_start_date).toBe('2026-03-01');
  });

  it('ends each monthly period on the last day of its month', async () => {
    await createPlan({ startDate: '2026-03-01', intervalUnit: 'month' });

    const rows = await periods();
    // March has 31 days, April 30. A fixed 30-day step would drift the schedule
    // a day per month and eventually bill twice in one month.
    expect(rows[0].period_end_date).toBe('2026-03-31');
    expect(rows[1].period_start_date).toBe('2026-04-01');
    expect(rows[1].period_end_date).toBe('2026-04-30');
  });

  it('carries the plan amount onto each period', async () => {
    await createPlan({ amount: 500 });

    const rows = await periods();
    expect(Number(rows[0].amount_cents)).toBe(50_000);
  });

  it('starts every period ready to bill', async () => {
    await createPlan();

    const rows = await periods();
    expect(rows[0].status).toBe('ready_to_bill');
  });
});

describe('updating a plan', () => {
  it('changes the amount', async () => {
    const created = await createPlan({ amount: 500 });

    const res = await owner.api.put(`${P()}/${created.body.plan.id}`).send({ amount: 700 });

    expect(res.status).toBe(200);
    expect(Number((await planRow(created.body.plan.id)).amount_cents)).toBe(70_000);
  });

  it('rejects the same huge finite value on UPDATE, not just create', async () => {
    const created = await createPlan({ amount: 500 });

    const res = await owner.api.put(`${P()}/${created.body.plan.id}`).send({ amount: 1e17 });

    expect(res.status).toBe(400);
    // Unchanged from the control amount, not corrupted and not silently accepted.
    expect(Number((await planRow(created.body.plan.id)).amount_cents)).toBe(50_000);
  });

  it('does not let one firm update another firm plan', async () => {
    const created = await createPlan({ amount: 500 });
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .put(`/api/lawfirms/${otherFirm.id}/billing/plans/${created.body.plan.id}`)
      .send({ amount: 999999 });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(Number((await planRow(created.body.plan.id)).amount_cents)).toBe(50_000);
  });
});

describe('drawing an invoice from a period', () => {
  let planId: string;

  const draft = (periodId: string) =>
    owner.api.post(`${P()}/${planId}/periods/${periodId}/create-draft`).send({});

  beforeEach(async () => {
    const created = await createPlan({ amount: 500, startDate: '2026-03-01' });
    planId = created.body.plan.id;
    await drainEvents();
  });

  it('creates an invoice for the period', async () => {
    const res = await draft('2026-03-01');

    expect(res.status).toBe(201);
    expect(res.body.invoice.id).toBeTruthy();
  });

  /**
   * The draft is dated today for whoever draws it. Goes red if it is the UTC
   * day: drawn at 8pm Pacific on September 27 it was dated the 28th.
   */
  it('dates the draft today for the person drawing it', async () => {
    freezeClockAt('2026-09-27T20:00:00-07:00');

    const res = await owner.api.post(`${P()}/${planId}/periods/2026-03-01/create-draft`)
      .set('x-timezone', 'America/Los_Angeles')
      .send({});

    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      'select invoice_date::text as day from invoices where id = $1', [res.body.invoice.id],
    );
    expect(rows[0].day).toBe('2026-09-27');
  });

  it('bills the plan amount', async () => {
    await draft('2026-03-01');

    const { rows } = await testPool.query(
      'select total_cents from invoices where law_firm_id = $1', [firm.id],
    );
    expect(Number(rows[0].total_cents)).toBe(50_000);
  });

  it('names the invoice after the plan and the period', async () => {
    await draft('2026-03-01');

    const { rows } = await testPool.query(
      'select invoice_name, billing_plan_id from invoices where law_firm_id = $1', [firm.id],
    );
    // A client receiving twelve near-identical retainer invoices needs to tell
    // them apart, and the firm needs to trace one back to the plan that made it.
    expect(rows[0].invoice_name).toContain('Monthly Retainer');
    expect(rows[0].invoice_name).toContain('2026-03-01');
    expect(rows[0].billing_plan_id).toBe(planId);
  });

  it('refuses to draft from a matter plan that names no payer', async () => {
    const clientForMatter = client;
    const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
      name: 'Retainer Matter', clients: [{ clientId: clientForMatter.id, name: clientForMatter.id }],
    });
    expect(matter.status).toBe(201);
    const created = await createPlan({
      contextType: 'matter', entityId: matter.body.matterId, startDate: '2026-03-01', amount: 500,
    });
    expect(created.status).toBe(201);

    // With no default client the draft has no payer at all: it cannot be paid
    // from trust and a payment request fails on recipients. Refuse with the fix.
    const res = await owner.api
      .post(`${P()}/${created.body.plan.id}/periods/2026-03-01/create-draft`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/default client/i);
    const { rows } = await testPool.query(
      'select count(*)::int c from invoices where billing_plan_id = $1', [created.body.plan.id],
    );
    expect(rows[0].c).toBe(0);
  });

  it('refuses to draw the SAME period twice', async () => {
    await draft('2026-03-01');

    const res = await draft('2026-03-01');

    // Two invoices for one month is a double charge, and the second looks
    // exactly as legitimate as the first.
    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      'select count(*)::int n from invoices where law_firm_id = $1', [firm.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('answers not-found for a period the plan does not have', async () => {
    const res = await draft('1999-01-01');

    expect(res.status).toBe(404);
  });

  it('refuses a period id that is not a date, without a 500', async () => {
    const res = await draft('24a71e09-9c7f-4df9-9f6e-0a6d851e79e3');

    // A period's id is its START DATE. `findPeriodById` guards `planId` with
    // `isUuid` one line above, then passes the period id straight into a
    // comparison against a `date` column, so anything that is not a date reaches
    // Postgres as a failed cast and returns 500 INTERNAL_ERROR.
    //
    // The uuid used here is exactly the shape a caller reaches for first: it is
    // the primary key of the `billing_plan_periods` row, which looks like the
    // obvious identifier and is not the one this API takes.
    expect(res.status).toBe(404);
  });

  it('refuses a plan id that is not a uuid', async () => {
    const res = await owner.api
      .post(`${P()}/not-a-uuid/periods/2026-03-01/create-draft`).send({});

    expect(res.status).toBe(404);
  });

  it('does not let one firm draw from another firm plan', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/billing/plans/${planId}/periods/2026-03-01/create-draft`)
      .send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
    const { rows } = await testPool.query(
      'select count(*)::int n from invoices where law_firm_id = $1', [otherFirm.id],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('listing plans', () => {
  it('lists what the firm has', async () => {
    await createPlan({ name: 'Findable Retainer' });

    const res = await owner.api.get(P());

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Findable Retainer');
  });

  it('does NOT list another firm plans', async () => {
    expect((await createPlan({ name: 'Confidential Retainer' })).status).toBe(201);
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    // The positive control: the owning firm lists it.
    const own = await owner.api.get(P());
    expect(JSON.stringify(own.body)).toContain('Confidential Retainer');

    const res = await otherOwner.api.get(`/api/lawfirms/${otherFirm.id}/billing/plans`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('Confidential Retainer');
  });
});
