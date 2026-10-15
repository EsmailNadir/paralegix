/**
 * B02 A07: a bulk id list that mixes the caller's own rows with a foreign one.
 *
 * `matters.test.ts` and `tasks.test.ts` already prove a bulk request that names
 * ONLY a foreign id touches nothing. What neither file tries is the case the
 * plan calls out separately: a MIXED list, one row the caller legitimately owns
 * and one that belongs to somebody else, in the SAME request. That is the case
 * that actually exercises the row-by-row contract rather than an all-or-nothing
 * shortcut, because a naive implementation could plausibly pass the
 * foreign-only test by rejecting the whole batch on the first bad id, and still
 * be wrong here by either touching the foreign row too or silently dropping the
 * caller's own valid one alongside it.
 *
 * `runBulk` (`matters.service.ts`) and the shared `fetchTasksForFirm` pattern
 * (`tasks.service.ts`/`tasks.repository.ts`) both promise a PARTIAL-RESULT
 * contract: every id is looked up under `law_firm_id = $1`, a foreign or
 * nonexistent id resolves to "not found" (the same message either way, so a
 * caller cannot use this to learn a row exists elsewhere), and the valid ids
 * proceed independently.
 *
 * `bulk-matter` is the interesting exception and gets its own section: the
 * DESTINATION matter id is validated once, up front, outside the per-item loop,
 * so a foreign destination is an all-or-nothing refusal of the whole request,
 * not a per-item failure. Both contracts are legitimate; the point of this file
 * is that they must not be confused with each other.
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

let home: Firm;
let owner: Actor;
let matterId: string;

let other: Firm;
let otherOwner: Actor;
let otherMatterId: string;

async function createHomeMatter(name: string) {
  const client = await createPersonClient(home.id, { name: `${name} Client` });
  const res = await owner.api.post(`/api/lawfirms/${home.id}/matters`).send({
    name, clients: [{ clientId: client.id, name: `${name} Client` }],
  });
  expect(res.status).toBe(201);
  return res.body.matterId as string;
}

async function createHomeTask(title: string, matter = matterId) {
  const res = await owner.api.post(`/api/lawfirms/${home.id}/tasks`).send({ title, matterId: matter });
  expect(res.status).toBe(201);
  return res.body.taskId as string;
}

const matterRow = async (id: string) => {
  const { rows } = await testPool.query('select status, law_firm_id from matters where id = $1', [id]);
  return rows[0];
};

const taskRow = async (id: string) => {
  const { rows } = await testPool.query('select status, matter_id, law_firm_id from tasks where id = $1', [id]);
  return rows[0];
};

beforeEach(async () => {
  home = await createFirm({ name: 'Home Firm' });
  owner = await ownerOf(home.id);
  matterId = await createHomeMatter('Home Matter');

  other = await createFirm({ name: 'Other Firm' });
  otherOwner = await ownerOf(other.id);
  const otherClient = await createPersonClient(other.id, { name: 'Other Client' });
  const otherMatter = await otherOwner.api.post(`/api/lawfirms/${other.id}/matters`).send({
    name: 'Other Matter', clients: [{ clientId: otherClient.id, name: 'Other Client' }],
  });
  expect(otherMatter.status).toBe(201);
  otherMatterId = otherMatter.body.matterId;

  await drainEvents();
});

describe('matters bulk-delete: one own id, one foreign id', () => {
  it('deletes the own matter and leaves the foreign one untouched', async () => {
    const mine = await createHomeMatter('Mine');

    const res = await owner.api.post(`/api/lawfirms/${home.id}/matters/bulk-delete`)
      .send({ matterIds: [mine, otherMatterId] });

    expect(res.status).toBe(200);
    expect(await matterRow(mine)).toBeUndefined();
    // The foreign row survives, in ITS OWN firm, completely unaffected.
    const survivor = await matterRow(otherMatterId);
    expect(survivor).toBeDefined();
    expect(survivor.law_firm_id).toBe(other.id);
  });

  it('reports the counts and the foreign id as a per-item failure', async () => {
    const mine = await createHomeMatter('Mine');

    const res = await owner.api.post(`/api/lawfirms/${home.id}/matters/bulk-delete`)
      .send({ matterIds: [mine, otherMatterId] });

    expect(res.body.requested).toBe(2);
    expect(res.body.deleted).toBe(1);
    expect(res.body.failed).toContain(otherMatterId);
    // The reason is the ordinary not-found message, identical to what a
    // genuinely nonexistent id would produce: it does not confirm the id
    // belongs to a real matter somewhere else.
    expect(res.body.errors[otherMatterId]).toBe('Matter not found');
  });
});

describe('matters bulk-update-status: one own id, one foreign id', () => {
  it('updates the own matter and leaves the foreign one at its prior status', async () => {
    const mine = await createHomeMatter('Mine');
    expect((await matterRow(mine)).status).not.toBe('closed');
    const foreignStatusBefore = (await matterRow(otherMatterId)).status;

    const res = await owner.api.post(`/api/lawfirms/${home.id}/matters/bulk-update-status`)
      .send({ matterIds: [mine, otherMatterId], status: 'closed' });

    expect(res.status).toBe(200);
    expect((await matterRow(mine)).status).toBe('closed');
    expect((await matterRow(otherMatterId)).status).toBe(foreignStatusBefore);
    expect(res.body.updated).toBe(1);
    expect(res.body.failed).toContain(otherMatterId);
  });
});

describe('tasks bulk-delete: one own id, one foreign id', () => {
  it('deletes the own task and leaves the foreign one untouched', async () => {
    const mine = await createHomeTask('Mine');
    const foreignTask = await otherOwner.api.post(`/api/lawfirms/${other.id}/tasks`)
      .send({ title: 'Foreign Confidential Task', matterId: otherMatterId });
    await drainEvents();

    const res = await owner.api.post(`/api/lawfirms/${home.id}/tasks/bulk-delete`)
      .send({ taskIds: [mine, foreignTask.body.taskId] });

    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(2);
    expect(res.body.deleted).toBe(1);
    expect(await taskRow(mine)).toBeUndefined();
    const survivor = await taskRow(foreignTask.body.taskId);
    expect(survivor).toBeDefined();
    expect(survivor.law_firm_id).toBe(other.id);
    // The response never has to mention the foreign task to report the count,
    // and it must not: its title is the confidential part.
    expect(JSON.stringify(res.body)).not.toContain('Foreign Confidential Task');
  });
});

describe('tasks bulk-status: one own id, one foreign id', () => {
  it('updates the own task and leaves the foreign one at its prior status', async () => {
    const mine = await createHomeTask('Mine');
    const foreignTask = await otherOwner.api.post(`/api/lawfirms/${other.id}/tasks`)
      .send({ title: 'Foreign Task', matterId: otherMatterId });
    await drainEvents();

    const res = await owner.api.post(`/api/lawfirms/${home.id}/tasks/bulk-status`)
      .send({ taskIds: [mine, foreignTask.body.taskId], status: 'completed' });

    expect(res.status).toBe(200);
    expect((await taskRow(mine)).status).toBe('completed');
    expect((await taskRow(foreignTask.body.taskId)).status).toBe('open');
    expect(res.body.updated).toBe(1);
    expect(res.body.failed).toContain(foreignTask.body.taskId);
  });
});

describe('tasks bulk-matter: the DESTINATION is checked up front, not per item', () => {
  it('refuses the whole request when the destination matter is foreign, moving nothing', async () => {
    const a = await createHomeTask('A');
    const b = await createHomeTask('B');

    const res = await owner.api.post(`/api/lawfirms/${home.id}/tasks/bulk-matter`)
      .send({ taskIds: [a, b], matterId: otherMatterId });

    // Unlike bulk-delete/bulk-status, this is all-or-nothing: the destination
    // gate runs BEFORE the per-task loop even starts, so a foreign destination
    // fails the entire call rather than reporting per-task failures.
    expect(res.status).toBe(404);
    expect((await taskRow(a)).matter_id).toBe(matterId);
    expect((await taskRow(b)).matter_id).toBe(matterId);
  });

  it('with a valid own destination, still moves only the own task and leaves the foreign one alone', async () => {
    const destination = await createHomeMatter('Destination');
    const mine = await createHomeTask('Mine');
    const foreignTask = await otherOwner.api.post(`/api/lawfirms/${other.id}/tasks`)
      .send({ title: 'Foreign Task', matterId: otherMatterId });
    await drainEvents();

    const res = await owner.api.post(`/api/lawfirms/${home.id}/tasks/bulk-matter`)
      .send({ taskIds: [mine, foreignTask.body.taskId], matterId: destination });

    expect(res.status).toBe(200);
    expect((await taskRow(mine)).matter_id).toBe(destination);
    // The per-item loop still runs AFTER the destination check passes, and the
    // foreign task id inside taskIds is refused there like any other bad id.
    expect((await taskRow(foreignTask.body.taskId)).matter_id).toBe(otherMatterId);
    expect(res.body.updated).toBe(1);
    expect(res.body.failed).toContain(foreignTask.body.taskId);
  });
});

describe('matters bulk-add-member: one own matter, one foreign matter', () => {
  it('adds the member to the own matter, reports the foreign one as failed, and discloses nothing about it', async () => {
    const { createFirmMember } = require('../support/setupInProcess');
    const colleague = await createFirmMember(home.id, { name: 'Colleague' });

    const res = await owner.api.post(`/api/lawfirms/${home.id}/matters/bulk-add-member`)
      .send({ userId: colleague.uid, matterIds: [matterId, otherMatterId] });

    expect(res.status).toBe(200);
    expect(res.body.added).toContain(matterId);
    expect(res.body.added).not.toContain(otherMatterId);
    const failedIds = res.body.failed.map((f: any) => f.matterId);
    expect(failedIds).toContain(otherMatterId);
    expect(JSON.stringify(res.body)).not.toContain('Other Matter');

    // The write actually happened for the valid matter, not merely "not rejected".
    const { rows } = await testPool.query(
      'select user_id from matter_members where matter_id = $1', [matterId],
    );
    expect(rows.map((r: any) => r.user_id)).toContain(colleague.uid);
  });
});
