/**
 * Moving a task off a matter under legal hold.
 *
 * A task on a held matter cannot be deleted, because its documents cascade with
 * it. Moving the task to another matter (or to no matter) first and deleting it
 * afterwards would get round that refusal, so the move itself is refused while
 * the hold is live. Each refusal case below goes red if the single update or the
 * bulk matter move stops reading the source matter's hold; the "still moves"
 * cases go red if the check refuses moves it should allow.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

const T = () => `/api/lawfirms/${firm.id}/tasks`;

async function createMatter(name: string) {
  const client = await createPersonClient(firm.id, { name: `${name} Client` });
  const res = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name, clients: [{ clientId: client.id, name: `${name} Client` }],
  });
  expect(res.status).toBe(201);
  return res.body.matterId as string;
}

async function createTask(title: string, matterId: string | null) {
  const res = await owner.api.post(T()).send({ title, ...(matterId ? { matterId } : {}) });
  expect(res.status).toBe(201);
  return (res.body.taskId ?? res.body.task?.id) as string;
}

async function placeHold(matterId: string) {
  await testPool.query(
    `insert into legal_holds (law_firm_id, matter_id, reason, placed_by)
     values ($1, $2, 'Litigation', $3)`,
    [firm.id, matterId, owner.uid],
  );
}

const matterOf = async (taskId: string) =>
  (await testPool.query('select matter_id from tasks where id = $1', [taskId])).rows[0].matter_id as string | null;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

describe('single task update', () => {
  it('refuses clearing the matter of a task on a held matter', async () => {
    const held = await createMatter('Held');
    const taskId = await createTask('Evidence task', held);
    await placeHold(held);

    const res = await owner.api.put(`${T()}/${taskId}`).send({ matterId: null });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/legal hold/i);
    expect(await matterOf(taskId)).toBe(held);
  });

  it('refuses moving a task on a held matter onto another matter', async () => {
    const held = await createMatter('Held');
    const other = await createMatter('Other');
    const taskId = await createTask('Evidence task', held);
    await placeHold(held);

    const res = await owner.api.put(`${T()}/${taskId}`).send({ matterId: other });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/legal hold/i);
    expect(await matterOf(taskId)).toBe(held);
  });

  it('still edits a task on a held matter when the matter does not change', async () => {
    const held = await createMatter('Held');
    const taskId = await createTask('Evidence task', held);
    await placeHold(held);

    const res = await owner.api.put(`${T()}/${taskId}`).send({ matterId: held, title: 'Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe('Renamed');
    expect(await matterOf(taskId)).toBe(held);
  });

  it('still moves a task off a matter that is not held', async () => {
    const free = await createMatter('Free');
    const other = await createMatter('Other');
    const taskId = await createTask('Task', free);

    const res = await owner.api.put(`${T()}/${taskId}`).send({ matterId: other });

    expect(res.status).toBe(200);
    expect(await matterOf(taskId)).toBe(other);
  });

  it('still moves a task onto a held matter', async () => {
    const held = await createMatter('Held');
    const taskId = await createTask('Loose task', null);
    await placeHold(held);

    const res = await owner.api.put(`${T()}/${taskId}`).send({ matterId: held });

    expect(res.status).toBe(200);
    expect(await matterOf(taskId)).toBe(held);
  });
});

describe('bulk matter move', () => {
  it('reports a held-matter task as a per-id failure and still moves the rest', async () => {
    const held = await createMatter('Held');
    const free = await createMatter('Free');
    const dest = await createMatter('Destination');
    const heldTask = await createTask('Held task', held);
    const freeTask = await createTask('Free task', free);
    const looseTask = await createTask('No matter', null);
    await placeHold(held);

    const res = await owner.api.post(`${T()}/bulk-matter`)
      .send({ taskIds: [heldTask, freeTask, looseTask], matterId: dest });
    await drainEvents();

    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(3);
    expect(res.body.updated).toBe(2);
    expect(res.body.failed).toEqual([heldTask]);
    expect(res.body.errors[heldTask]).toMatch(/legal hold/i);
    expect(await matterOf(heldTask)).toBe(held);
    expect(await matterOf(freeTask)).toBe(dest);
    expect(await matterOf(looseTask)).toBe(dest);
  });

  it('refuses clearing the matter of a held-matter task in bulk', async () => {
    const held = await createMatter('Held');
    const heldTask = await createTask('Held task', held);
    await placeHold(held);

    const res = await owner.api.post(`${T()}/bulk-matter`)
      .send({ taskIds: [heldTask], matterId: null });
    await drainEvents();

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
    expect(res.body.errors[heldTask]).toMatch(/legal hold/i);
    expect(await matterOf(heldTask)).toBe(held);
  });

  it('leaves a held-matter task alone when the bulk destination is its own matter', async () => {
    const held = await createMatter('Held');
    const heldTask = await createTask('Held task', held);
    await placeHold(held);

    const res = await owner.api.post(`${T()}/bulk-matter`)
      .send({ taskIds: [heldTask], matterId: held });
    await drainEvents();

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.failed).toEqual([]);
    expect(await matterOf(heldTask)).toBe(held);
  });
});
