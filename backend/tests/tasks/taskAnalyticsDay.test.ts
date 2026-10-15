/**
 * Task analytics counts days in the caller's zone.
 */
import { randomUUID } from 'crypto';
import { testPool, createFirm, ownerOf, type Actor, type Firm } from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

/** Today in `zone`, read through Postgres's own clock, which the query runs against. */
async function todayIn(zone: string) {
  const { rows } = await testPool.query('select (now() at time zone $1)::date::text as d', [zone]);
  return rows[0].d as string;
}

describe('task analytics overdue', () => {
  /**
   * A task is overdue once its due day is behind the caller's today. Goes red
   * if it is "noon UTC on the due day has passed": at UTC-12 that is true for
   * every task due today, all day long.
   */
  it('does not count a task due today', async () => {
    const zone = 'Etc/GMT+12';
    const today = await todayIn(zone);
    await testPool.query(
      `insert into tasks (id, law_firm_id, title, status, due_date, created_by) values ($1, $2, 'Due today', 'open', $3, $4)`,
      [randomUUID(), firm.id, today, owner.uid],
    );

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/tasks/analytics`).set('x-timezone', zone);

    expect(res.status).toBe(200);
    expect(res.body.summary?.overdue ?? res.body.overdue).toBe(0);
  });

  it('counts a task due yesterday', async () => {
    const zone = 'Etc/GMT+12';
    const today = await todayIn(zone);
    const { rows } = await testPool.query(`select ($1::date - 1)::text as d`, [today]);
    await testPool.query(
      `insert into tasks (id, law_firm_id, title, status, due_date, created_by) values ($1, $2, 'Due yesterday', 'open', $3, $4)`,
      [randomUUID(), firm.id, rows[0].d, owner.uid],
    );

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/tasks/analytics`).set('x-timezone', zone);

    expect(res.status).toBe(200);
    expect(res.body.summary?.overdue ?? res.body.overdue).toBe(1);
  });
});
