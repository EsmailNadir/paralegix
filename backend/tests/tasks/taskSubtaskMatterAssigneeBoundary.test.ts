/**
 * A matter task may only be assigned to members of that matter. `tasks.service`
 * already enforces this for its own assignedTo junction; subtask create/update
 * must not bypass the same ethical-wall boundary through assignee_user_id.
 */
import { randomUUID } from 'crypto';
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
let matterId: string;
let taskId: string;

const T = (suffix = '') => `/api/lawfirms/${firm.id}/tasks${suffix}`;

async function createSubtask(body: Record<string, unknown>) {
  return owner.api.post(T(`/${taskId}/subtasks`)).send({ title: 'Review declaration', ...body });
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  matterId = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, 'Restricted matter', $3)`,
    [matterId, firm.id, `REF-${matterId.slice(0, 8)}`],
  );
  await testPool.query(
    'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
    [firm.id, matterId, owner.uid],
  );
  const task = await owner.api.post(T()).send({ title: 'Parent task', matterId });
  expect(task.status).toBe(201);
  taskId = task.body.taskId;
});

describe('subtask assignees respect the parent matter boundary', () => {
  it('refuses creating a subtask assigned to a firm member outside the matter', async () => {
    const outsider = await memberWith(firm.id, ['tasks.view']);

    const created = await createSubtask({ assigneeUserId: outsider.uid });

    expect(created.status).toBe(403);
    const { rows } = await testPool.query(
      'select 1 from task_subtasks where task_id = $1',
      [taskId],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses reassigning an existing subtask to a firm member outside the matter', async () => {
    const outsider = await memberWith(firm.id, ['tasks.view']);
    const created = await createSubtask({});
    expect(created.status).toBe(201);

    const updated = await owner.api.put(T(`/${taskId}/subtasks/${created.body.subtask.id}`))
      .send({ assigneeUserId: outsider.uid });

    expect(updated.status).toBe(403);
    const { rows } = await testPool.query(
      'select assignee_user_id from task_subtasks where id = $1',
      [created.body.subtask.id],
    );
    expect(rows[0].assignee_user_id).toBeNull();
  });

  it('allows assigning a subtask to another member of the parent matter', async () => {
    const colleague = await memberWith(firm.id, ['tasks.view']);
    await testPool.query(
      'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
      [firm.id, matterId, colleague.uid],
    );

    const created = await createSubtask({ assigneeUserId: colleague.uid });

    expect(created.status).toBe(201);
    expect(created.body.subtask.assigneeUserId).toBe(colleague.uid);
  });
});
