/**
 * Standalone task assignees receive assignment notifications and calendar
 * fan-out. They must be members of the task's firm; an arbitrary Firebase UID
 * must not turn those delivery paths into a cross-firm disclosure mechanism.
 */
import {
  createFirm,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let colleague: Actor;
let otherFirmOwner: Actor;

const T = () => `/api/lawfirms/${firm.id}/tasks`;

async function taskCount() {
  const { rows } = await testPool.query(
    'select count(*)::int as count from tasks where law_firm_id = $1',
    [firm.id],
  );
  return rows[0].count as number;
}

async function assigneesFor(taskId: string) {
  const { rows } = await testPool.query(
    'select user_id from task_assignees where task_id = $1 order by user_id',
    [taskId],
  );
  return rows.map((row: any) => row.user_id) as string[];
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  colleague = await memberWith(firm.id, ['tasks.view']);
  otherFirmOwner = await ownerOf((await createFirm()).id);
});

describe('standalone task assignee tenancy', () => {
  it('does not let a task creator assign a task to a user from another firm', async () => {
    const res = await owner.api.post(T()).send({
      title: 'Cross-firm task disclosure',
      assignedTo: [otherFirmOwner.uid],
    });

    // TASK_CREATED would otherwise notify and calendar-sync this task to the
    // foreign UID. Refuse before the task row exists.
    expect(res.status).toBe(403);
    expect(await taskCount()).toBe(0);
  });

  it('allows a real member of this firm to receive a standalone task', async () => {
    const res = await owner.api.post(T()).send({
      title: 'Internal administration task',
      assignedTo: [colleague.uid],
    });

    expect(res.status).toBe(201);
    expect(await taskCount()).toBe(1);
  });

  it('does not let a later standalone-task update add a foreign assignee', async () => {
    const created = await owner.api.post(T()).send({ title: 'Existing internal task' });
    expect(created.status).toBe(201);

    const res = await owner.api.put(`${T()}/${created.body.taskId}`).send({
      assignedTo: [otherFirmOwner.uid],
    });

    expect(res.status).toBe(403);
    expect(await assigneesFor(created.body.taskId)).toEqual([]);
  });
});

export {};
