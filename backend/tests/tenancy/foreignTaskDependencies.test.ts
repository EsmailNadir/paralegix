/**
 * B02.2 A06: foreign TASK-DEPENDENCY references in the create/update task body.
 *
 * The other reference types this row covers (client, member, matter, account,
 * template, folder) already have dedicated coverage — see
 * `foreignMemberReferences.test.ts`, `foreignClientWrites.test.ts` and
 * siblings. Task-to-task dependency edges were the one gap: `syncDependencies`
 * (`src/modules/tasks/tasks.repository.ts`) resolves the proposed
 * `dependencies` array against a tenant-scoped `tasks` select
 * (`tenantQuery(tasks, lawFirmId, ...)`), so a foreign-firm task id simply
 * matches no row and is dropped — same "removes the existence oracle"
 * contract as `syncTaskClients`/`syncAssignees`, per the comment directly
 * above the insert:
 *
 *   "Only depend on tasks in the SAME firm ... a foreign id simply matches no
 *   row and is dropped, instead of raising an FK error that reveals whether
 *   the uuid exists."
 *
 * That is a deliberate silent-drop contract, not a 403/404 refusal like the
 * member-reference class: unlike an assignee (which would hand a stranger
 * firm access or work), a dropped dependency edge only affects this firm's
 * own task, so there is nothing to refuse — the create/update simply
 * succeeds with the foreign id quietly excluded. This file drives that
 * through the real POST/PUT routes, which no existing test did:
 * `taskListReads.test.ts` seeds `task_dependencies` with raw SQL for
 * read-path (GET) assertions only and never exercises the write path.
 */
import {
  createFirm,
  createPersonClient,
  ownerOf,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let home: Firm;
let owner: Actor;
let matterId: string;

let other: Firm;
let otherOwner: Actor;
let foreignTaskId: string;

beforeEach(async () => {
  home = await createFirm({ name: 'Home Firm' });
  owner = await ownerOf(home.id);
  const client = await createPersonClient(home.id, { name: 'Home Client' });
  const matter = await owner.api.post(`/api/lawfirms/${home.id}/matters`).send({
    name: 'Home Matter', clients: [{ clientId: client.id, name: 'Home Client' }],
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;

  other = await createFirm({ name: 'Other Firm' });
  otherOwner = await ownerOf(other.id);
  const foreignTask = await otherOwner.api.post(`/api/lawfirms/${other.id}/tasks`)
    .send({ title: 'Foreign Confidential Task' });
  expect(foreignTask.status).toBe(201);
  foreignTaskId = foreignTask.body.taskId;

  await drainEvents();
});

describe('creating a task with a dependencies array mixing an own-firm and a foreign-firm task id', () => {
  it('silently drops the foreign id and keeps only the valid own-firm dependency', async () => {
    const blocker = await owner.api.post(`/api/lawfirms/${home.id}/tasks`)
      .send({ title: 'Blocking task', matterId });
    expect(blocker.status).toBe(201);
    const blockerId = blocker.body.taskId;

    const res = await owner.api.post(`/api/lawfirms/${home.id}/tasks`).send({
      title: 'Dependent task',
      matterId,
      dependencies: [blockerId, foreignTaskId],
    });

    expect(res.status).toBe(201);
    expect(res.body.task.dependencies).toEqual([blockerId]);
    expect(JSON.stringify(res.body)).not.toContain('Foreign Confidential Task');
  });

  it('creates a task with no dependencies at all when every id is foreign', async () => {
    const res = await owner.api.post(`/api/lawfirms/${home.id}/tasks`).send({
      title: 'Dependent task',
      matterId,
      dependencies: [foreignTaskId],
    });

    expect(res.status).toBe(201);
    expect(res.body.task.dependencies).toEqual([]);
  });
});

describe('updating a task with a dependencies array mixing an own-firm and a foreign-firm task id', () => {
  it('silently drops the foreign id and keeps only the valid own-firm dependency', async () => {
    const blocker = await owner.api.post(`/api/lawfirms/${home.id}/tasks`)
      .send({ title: 'Blocking task', matterId });
    expect(blocker.status).toBe(201);
    const blockerId = blocker.body.taskId;

    const dependent = await owner.api.post(`/api/lawfirms/${home.id}/tasks`)
      .send({ title: 'Dependent task', matterId });
    expect(dependent.status).toBe(201);
    const dependentId = dependent.body.taskId;
    await drainEvents();

    const res = await owner.api.put(`/api/lawfirms/${home.id}/tasks/${dependentId}`).send({
      dependencies: [blockerId, foreignTaskId],
    });

    expect(res.status).toBe(200);
    expect(res.body.task.dependencies).toEqual([blockerId]);
    expect(JSON.stringify(res.body)).not.toContain('Foreign Confidential Task');
  });
});
