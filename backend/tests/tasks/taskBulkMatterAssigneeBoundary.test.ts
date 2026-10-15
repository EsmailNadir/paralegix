/**
 * The ordinary task update revalidates assignees when it moves a task onto a
 * matter. Bulk assignment reaches the same `matter_id` change and must not
 * carry an outside assignee through the matter's ethical wall.
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
let mover: Actor;
let outsider: Actor;
let matterId: string;
let taskId: string;

const T = () => `/api/lawfirms/${firm.id}/tasks`;

async function taskMatterId() {
  const { rows } = await testPool.query(
    'select matter_id from tasks where law_firm_id = $1 and id = $2',
    [firm.id, taskId],
  );
  return rows[0]?.matter_id ?? null;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  mover = await memberWith(firm.id, ['tasks.view', 'tasks.update', 'matters.view']);
  outsider = await memberWith(firm.id, ['tasks.view']);

  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Restricted destination matter',
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;
  const added = await owner.api
    .post(`/api/lawfirms/${firm.id}/matters/${matterId}/members`)
    .send({ targetUserIds: [mover.uid] });
  expect(added.status).toBe(200);

  const task = await owner.api.post(T()).send({
    title: 'Standalone work with an outside assignee',
    assignedTo: [outsider.uid],
  });
  expect(task.status).toBe(201);
  taskId = task.body.taskId;
});

describe('bulk matter assignment validates task assignees against the destination matter', () => {
  it('keeps the task detached when its current assignee is outside the destination matter', async () => {
    // This direct route is the canonical control: it already detects that the
    // existing assignee would become an outsider after the move.
    const direct = await mover.api.put(`${T()}/${taskId}`).send({ matterId });
    expect(direct.status).toBe(403);
    expect(await taskMatterId()).toBeNull();

    const bulk = await mover.api.post(`${T()}/bulk-matter`).send({
      taskIds: [taskId],
      matterId,
    });

    // Bulk operations report item failures in their 200 response, rather than
    // partially writing an unethical assignment.
    expect(bulk.status).toBe(200);
    expect(bulk.body.updated).toBe(0);
    expect(bulk.body.failed).toEqual([taskId]);
    expect(await taskMatterId()).toBeNull();
  });

  it('moves the same task after its assignee is added to the destination matter', async () => {
    const added = await owner.api
      .post(`/api/lawfirms/${firm.id}/matters/${matterId}/members`)
      .send({ targetUserIds: [outsider.uid] });
    expect(added.status).toBe(200);

    const bulk = await mover.api.post(`${T()}/bulk-matter`).send({
      taskIds: [taskId],
      matterId,
    });

    expect(bulk.status).toBe(200);
    expect(bulk.body.updated).toBe(1);
    expect(bulk.body.failed).toEqual([]);
    expect(await taskMatterId()).toBe(matterId);
  });

  it('also keeps a task detached when only its explicit reminder recipient is outside the matter', async () => {
    const task = await owner.api.post(T()).send({
      title: 'Standalone task with an outside reminder recipient',
      dueDate: '2026-10-01',
      reminderRecipientIds: [outsider.uid],
    });
    expect(task.status).toBe(201);
    const reminderTaskId = task.body.taskId;

    const bulk = await mover.api.post(`${T()}/bulk-matter`).send({
      taskIds: [reminderTaskId],
      matterId,
    });

    expect(bulk.status).toBe(200);
    expect(bulk.body.updated).toBe(0);
    expect(bulk.body.failed).toEqual([reminderTaskId]);
    const { rows } = await testPool.query(
      'select matter_id from tasks where law_firm_id = $1 and id = $2',
      [firm.id, reminderTaskId],
    );
    expect(rows[0].matter_id).toBeNull();
  });
});

export {};
