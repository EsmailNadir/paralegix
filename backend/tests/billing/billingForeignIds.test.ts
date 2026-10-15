/**
 * Ids in a request body that name another record must name one of THIS firm's.
 *
 * A time entry's charge code and an expense's category are both
 * `activities.billing_code_id`. It used to accept any code in the database, so
 * a firm could stamp another firm's code (or an expense category) onto its
 * time. A plan's default client is the payer every drafted invoice bills, and
 * it was stored unchecked.
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
} from '../support/setupInProcess';
import { seedMatter } from '../support/matters';

let firm: Firm;
let rival: Firm;
let owner: Actor;
let client: ClientRecord;

const B = () => `/api/lawfirms/${firm.id}/billing`;

async function seedCode(lawFirmId: string, kind: 'charge' | 'expense') {
  const id = randomUUID();
  await testPool.query(
    `insert into billing_codes (id, law_firm_id, kind, code, name) values ($1, $2, $3, $4, 'Seeded')`,
    [id, lawFirmId, kind, `K${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`],
  );
  return id;
}

const activityCount = async (kind: string) => Number((await testPool.query(
  'select count(*)::int n from activities where law_firm_id = $1 and kind = $2', [firm.id, kind],
)).rows[0].n);

const codeOf = async (id: string) => (await testPool.query(
  'select billing_code_id from activities where id = $1', [id],
)).rows[0].billing_code_id;

const logTime = (extra: Record<string, unknown> = {}) => owner.api.post(`${B()}/time-entries`).send({
  clientId: client.id, userId: owner.uid, hours: 1, date: '2026-03-10', hourlyRate: 200, ...extra,
});

const addExpense = (extra: Record<string, unknown> = {}) => owner.api.post(`${B()}/expenses`).send({
  clientId: client.id, description: 'Courier', amount: 40, date: '2026-03-10', ...extra,
});

beforeEach(async () => {
  firm = await createFirm();
  rival = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Home Client' });
  await drainEvents();
});

describe('a time entry charge code', () => {
  it('accepts one of the firm own charge codes and stores it', async () => {
    const code = await seedCode(firm.id, 'charge');
    const res = await logTime({ chargeCodeId: code });

    expect(res.status).toBe(201);
    expect(await codeOf(res.body.timeEntry.id)).toBe(code);
  });

  /** Red if the firm check is missing: 201 with the rival's code stored. */
  it('refuses another firm charge code and writes nothing', async () => {
    const theirs = await seedCode(rival.id, 'charge');
    const res = await logTime({ chargeCodeId: theirs });

    expect(res.status).toBe(400);
    expect(await activityCount('time')).toBe(0);
  });

  /** Red if the check is firm-only and ignores kind. */
  it('refuses an expense category passed as a charge code', async () => {
    const category = await seedCode(firm.id, 'expense');
    const res = await logTime({ chargeCodeId: category });

    expect(res.status).toBe(400);
    expect(await activityCount('time')).toBe(0);
  });

  /** Red if the schema is not `.uuid()`: the cast fails in Postgres and answers 500. */
  it('answers 400 for a charge code id that is not a uuid', async () => {
    const res = await logTime({ chargeCodeId: 'not-a-code' });

    expect(res.status).toBe(400);
    expect(await activityCount('time')).toBe(0);
  });

  /** The update path. Red if only create is checked. */
  it('refuses another firm charge code on update and leaves the entry alone', async () => {
    const created = await logTime();
    expect(created.status).toBe(201);
    const id = created.body.timeEntry.id;
    const theirs = await seedCode(rival.id, 'charge');

    const res = await owner.api.put(`${B()}/time-entries/client/${client.id}/${id}`).send({ chargeCodeId: theirs });

    expect(res.status).toBe(400);
    expect(await codeOf(id)).toBeNull();

    const mine = await seedCode(firm.id, 'charge');
    const ok = await owner.api.put(`${B()}/time-entries/client/${client.id}/${id}`).send({ chargeCodeId: mine });
    expect(ok.status).toBe(200);
    expect(await codeOf(id)).toBe(mine);
  });
});

describe('an expense category', () => {
  it('accepts one of the firm own categories and stores it', async () => {
    const category = await seedCode(firm.id, 'expense');
    const res = await addExpense({ expenseCategoryId: category });

    expect(res.status).toBe(201);
    expect(await codeOf(res.body.expenseId)).toBe(category);
  });

  it.each([
    ['another firm category', async () => seedCode(rival.id, 'expense')],
    ['a charge code', async () => seedCode(firm.id, 'charge')],
    ['a non-uuid', async () => 'travel'],
  ])('refuses %s and writes nothing', async (_label, idFor) => {
    const res = await addExpense({ expenseCategoryId: await idFor() });

    expect(res.status).toBe(400);
    expect(await activityCount('expense')).toBe(0);
  });

  it('refuses another firm category on update and leaves the expense alone', async () => {
    const created = await addExpense();
    expect(created.status).toBe(201);
    const theirs = await seedCode(rival.id, 'expense');

    const res = await owner.api.put(`${B()}/expenses/client/${client.id}/${created.body.expenseId}`)
      .send({ expenseCategoryId: theirs });

    expect(res.status).toBe(400);
    expect(await codeOf(created.body.expenseId)).toBeNull();
  });
});

describe('the database refuses a cross-firm code too', () => {
  /** Red without migration 0023: the single-column key accepts the rival's code. */
  it('rejects an activity row naming another firm code', async () => {
    const theirs = await seedCode(rival.id, 'charge');

    await expect(testPool.query(
      `insert into activities (kind, law_firm_id, client_id, activity_date, hours, billing_code_id)
       values ('time', $1, $2, '2026-03-10', 1, $3)`,
      [firm.id, client.id, theirs],
    )).rejects.toMatchObject({ code: '23503' });
  });

  /**
   * Deleting a code clears only the code, never the firm. Red if the composite
   * key is written as a plain `on delete set null` (23502 on law_firm_id).
   */
  it('clears only billing_code_id when the code is deleted', async () => {
    const mine = await seedCode(firm.id, 'charge');
    const { rows } = await testPool.query(
      `insert into activities (kind, law_firm_id, client_id, activity_date, hours, billing_code_id)
       values ('time', $1, $2, '2026-03-10', 1, $3) returning id`,
      [firm.id, client.id, mine],
    );

    await testPool.query('delete from billing_codes where id = $1', [mine]);

    const after = await testPool.query('select law_firm_id, billing_code_id from activities where id = $1', [rows[0].id]);
    expect(after.rows[0]).toEqual({ law_firm_id: firm.id, billing_code_id: null });
  });
});

describe('a plan default client', () => {
  const P = () => `${B()}/plans`;
  const planCount = async () => Number((await testPool.query(
    'select count(*)::int n from billing_plans where law_firm_id = $1', [firm.id],
  )).rows[0].n);
  const planBody = (extra: Record<string, unknown>) => ({
    name: 'Retainer', intervalUnit: 'month', startDate: '2026-03-01', amount: 500, ...extra,
  });

  it('refuses another firm client as the default client and writes no plan', async () => {
    const theirs = await createPersonClient(rival.id, { name: 'Rival Client' });

    const res = await owner.api.post(P()).send(planBody({
      contextType: 'client', entityId: client.id, defaultClientId: theirs.id,
    }));

    expect(res.status).toBe(400);
    expect(await planCount()).toBe(0);
  });

  it('refuses, on a matter plan, a firm client who is not on the matter', async () => {
    const outsider = await createPersonClient(firm.id, { name: 'Not On Matter' });
    const matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });

    const res = await owner.api.post(P()).send(planBody({
      contextType: 'matter', entityId: matterId, defaultClientId: outsider.id,
    }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/client on this matter/i);
    expect(await planCount()).toBe(0);
  });

  it('accepts a client on the matter and stores it', async () => {
    const matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });

    const res = await owner.api.post(P()).send(planBody({
      contextType: 'matter', entityId: matterId, defaultClientId: client.id,
    }));

    expect(res.status).toBe(201);
    const { rows } = await testPool.query('select default_client_id from billing_plans where id = $1', [res.body.plan.id]);
    expect(rows[0].default_client_id).toBe(client.id);
  });

  it('refuses another firm client on update and leaves the plan alone', async () => {
    const matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
    const created = await owner.api.post(P()).send(planBody({
      contextType: 'matter', entityId: matterId, defaultClientId: client.id,
    }));
    expect(created.status).toBe(201);
    const theirs = await createPersonClient(rival.id, { name: 'Rival Client' });

    const res = await owner.api.put(`${P()}/${created.body.plan.id}`).send({ defaultClientId: theirs.id });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query('select default_client_id from billing_plans where id = $1', [created.body.plan.id]);
    expect(rows[0].default_client_id).toBe(client.id);
  });

  it('answers 400 for a default client id that is not a uuid', async () => {
    const res = await owner.api.post(P()).send(planBody({
      contextType: 'client', entityId: client.id, defaultClientId: 'someone',
    }));

    expect(res.status).toBe(400);
    expect(await planCount()).toBe(0);
  });
});
