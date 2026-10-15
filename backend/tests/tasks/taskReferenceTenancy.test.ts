/**
 * Tasks store practice-area and court IDs behind single-column foreign keys.
 * The database can prove each UUID exists, but not that it belongs to the
 * task's firm, so the service must keep foreign reference data out.
 */
import { randomUUID } from 'crypto';
import {
  createFirm,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let otherFirm: Firm;
let foreignPracticeAreaId: string;
let foreignCourtId: string;

const T = () => `/api/lawfirms/${firm.id}/tasks`;

async function taskCount() {
  const { rows } = await testPool.query(
    'select count(*)::int as count from tasks where law_firm_id = $1',
    [firm.id],
  );
  return rows[0].count as number;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  otherFirm = await createFirm();
  foreignPracticeAreaId = randomUUID();
  foreignCourtId = randomUUID();
  await testPool.query(
    'insert into practice_areas (id, law_firm_id, name) values ($1, $2, $3)',
    [foreignPracticeAreaId, otherFirm.id, 'Foreign Practice Area'],
  );
  await testPool.query(
    'insert into courts (id, law_firm_id, name) values ($1, $2, $3)',
    [foreignCourtId, otherFirm.id, 'Foreign Court'],
  );
});

describe('task practice-area and court references stay in the task firm', () => {
  it.each([
    ['practice area', 'practiceAreaId', () => foreignPracticeAreaId],
    ['court', 'courtId', () => foreignCourtId],
  ])('refuses a foreign %s ID before creating a task', async (_label, field, foreignId) => {
    const res = await owner.api.post(T()).send({
      title: 'Foreign-reference task',
      [field]: foreignId(),
    });

    expect(res.status).toBe(400);
    expect(await taskCount()).toBe(0);
  });

  it.each([
    ['practice area', 'practiceAreaId', () => foreignPracticeAreaId, 'practice_area_id'],
    ['court', 'courtId', () => foreignCourtId, 'court_id'],
  ])('does not let a task update stamp a foreign %s ID', async (_label, field, foreignId, column) => {
    const created = await owner.api.post(T()).send({ title: 'Existing local task' });
    expect(created.status).toBe(201);

    const res = await owner.api.put(`${T()}/${created.body.taskId}`).send({
      [field]: foreignId(),
    });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      `select ${column} from tasks where id = $1`,
      [created.body.taskId],
    );
    expect(rows[0][column]).toBeNull();
  });
});

export {};
