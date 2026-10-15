/**
 * Deleting a task on a matter under legal hold.
 *
 * A task's documents cascade with the task row, and the delete sweeps their
 * stored objects inside the request. The files routes refuse to delete a held
 * matter's documents, so a task delete that skipped the same check was a side
 * door: put the evidence on a task, delete the task, and the hold preserved
 * nothing. Each case below goes red if the single or bulk task delete stops
 * reading the matter's live hold.
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
} from '../support/setupInProcess';
import { installInMemoryBucket, objects, putObject } from '../support/inMemoryBucket';

installInMemoryBucket();

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

/** A finalized document under the task's scope root, with its object stored. */
async function attachFile(taskId: string, matterId: string | null) {
  const root = await testPool.query(
    `insert into files (law_firm_id, kind, name, scope, matter_id, task_id)
     values ($1, 'folder', '', 'task', $2, $3) returning id`,
    [firm.id, matterId, taskId],
  );
  const objectPath = `lawfirmids/${firm.id}/objects/${randomUUID()}`;
  const file = await testPool.query(
    `insert into files (law_firm_id, kind, name, parent_id, scope, matter_id, task_id,
                        object_path, mime_type, size_bytes, finalized_at)
     values ($1, 'file', 'evidence.pdf', $2, 'task', $3, $4, $5, 'application/pdf', 10, now())
     returning id`,
    [firm.id, root.rows[0].id, matterId, taskId, objectPath],
  );
  putObject(objectPath, { bytes: 10 });
  return { fileId: file.rows[0].id as string, objectPath };
}

async function placeHold(matterId: string) {
  await testPool.query(
    `insert into legal_holds (law_firm_id, matter_id, reason, placed_by)
     values ($1, $2, 'Litigation', $3)`,
    [firm.id, matterId, owner.uid],
  );
}

const taskExists = async (id: string) =>
  (await testPool.query('select 1 from tasks where id = $1', [id])).rowCount === 1;
const fileExists = async (id: string) =>
  (await testPool.query('select 1 from files where id = $1', [id])).rowCount === 1;

beforeEach(async () => {
  objects.clear();
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

describe('single task delete', () => {
  it('refuses a task on a held matter and keeps the task, its file row and its object', async () => {
    const matterId = await createMatter('Held');
    const taskId = await createTask('Evidence task', matterId);
    const { fileId, objectPath } = await attachFile(taskId, matterId);
    await placeHold(matterId);

    const res = await owner.api.delete(`${T()}/${taskId}`);
    await drainEvents();

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/legal hold/i);
    expect(await taskExists(taskId)).toBe(true);
    expect(await fileExists(fileId)).toBe(true);
    expect(objects.has(objectPath)).toBe(true);
  });

  it('deletes the same task once the hold is released', async () => {
    const matterId = await createMatter('Released');
    const taskId = await createTask('Evidence task', matterId);
    const { fileId } = await attachFile(taskId, matterId);
    await placeHold(matterId);
    await testPool.query(
      'update legal_holds set released_at = now(), released_by = $2 where matter_id = $1',
      [matterId, owner.uid],
    );

    const res = await owner.api.delete(`${T()}/${taskId}`);

    // Proves the refusal above reads the LIVE hold, not any hold row ever placed.
    expect(res.status).toBe(200);
    expect(await taskExists(taskId)).toBe(false);
    expect(await fileExists(fileId)).toBe(false);
  });
});

describe('bulk task delete', () => {
  it('reports a held-matter task as a per-id failure and still deletes the rest', async () => {
    const heldMatter = await createMatter('Held');
    const freeMatter = await createMatter('Free');
    const heldTask = await createTask('Held task', heldMatter);
    const freeTask = await createTask('Free task', freeMatter);
    const looseTask = await createTask('No matter', null);
    const { fileId, objectPath } = await attachFile(heldTask, heldMatter);
    await placeHold(heldMatter);

    const res = await owner.api.post(`${T()}/bulk-delete`)
      .send({ taskIds: [heldTask, freeTask, looseTask] });
    await drainEvents();

    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(3);
    expect(res.body.deleted).toBe(2);
    expect(res.body.failed).toEqual([heldTask]);
    expect(res.body.errors[heldTask]).toMatch(/legal hold/i);
    expect(await taskExists(heldTask)).toBe(true);
    expect(await fileExists(fileId)).toBe(true);
    expect(objects.has(objectPath)).toBe(true);
    expect(await taskExists(freeTask)).toBe(false);
    expect(await taskExists(looseTask)).toBe(false);
  });
});
