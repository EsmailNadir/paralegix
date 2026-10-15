/**
 * POST /api/lawfirms/:lawFirmId/tasks/bulk-matter: how many pool connections the
 * destination-matter assignee check costs, and what it still reports per task.
 *
 * Moving a task ONTO a matter re-checks every assignee and reminder recipient
 * against the destination matter's roster, because the move changes the ethical
 * wall those people sit behind. That check used to run per task, twice, one after
 * the other, so a "select all" move made two sequential round trips per task on a
 * pool of twelve connections shared by every request on the instance.
 *
 * The roster is the same for every task in one request, so it is one query. What
 * must not change is the answer: the task with an outsider on it still fails, on
 * its own, with the same message naming that person, and every other task still
 * moves.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  memberWith,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

// Loaded after the harness, which points DATABASE_URL at this worker's test
// database: `db.ts` reads the URL when it is first imported.
const { pool } = require('../../src/shared/database/db');
const eventBus = require('../../src/shared/events/eventBus');
const { TASK_UPDATED } = require('../../src/shared/events/eventTypes');

let firm: Firm;
let owner: Actor;
let insider: Actor;
let outsider: Actor;
let matterId: string;

const T = () => `/api/lawfirms/${firm.id}/tasks`;

/** A standalone task (no matter) assigned to `assignee`, ready to be moved. */
async function createTask(title: string, assignee: string) {
  const res = await owner.api.post(T()).send({ title, assignedTo: [assignee] });
  expect(res.status).toBe(201);
  return res.body.taskId as string;
}

async function matterOf(taskId: string) {
  const { rows } = await testPool.query(
    'select matter_id from tasks where law_firm_id = $1 and id = $2',
    [firm.id, taskId],
  );
  return rows[0]?.matter_id ?? null;
}

/** The label `assertMatterMemberships` puts in its message for a firm member. */
async function displayName(uid: string) {
  const { rows } = await testPool.query(
    'select coalesce(name, email, id) as label from users where id = $1', [uid]);
  return rows[0].label as string;
}

// Held connections are tracked by client object rather than a counter: a
// connection checked out before the measurement (an earlier request's background
// write) can be released during it, and a counter would under-report the peak.
async function checkoutsDuring(work: () => Promise<any>) {
  const held = new Set<unknown>();
  let peak = 0;
  let total = 0;
  const onAcquire = (client: unknown) => { total += 1; held.add(client); peak = Math.max(peak, held.size); };
  const onRelease = (_err: unknown, client: unknown) => { held.delete(client); };
  pool.on('acquire', onAcquire);
  pool.on('release', onRelease);
  try {
    const result = await work();
    return { result, peak, total };
  } finally {
    pool.off('acquire', onAcquire);
    pool.off('release', onRelease);
  }
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  insider = await memberWith(firm.id, ['tasks.view']);
  outsider = await memberWith(firm.id, ['tasks.view']);

  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Destination Matter',
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;
  const added = await owner.api
    .post(`/api/lawfirms/${firm.id}/matters/${matterId}/members`)
    .send({ targetUserIds: [insider.uid] });
  expect(added.status).toBe(200);
  await drainEvents();
});

describe('what a batched destination-matter check still reports', () => {
  it('fails only the task carrying an outsider, and names them exactly as before', async () => {
    const first = await createTask('Moves cleanly', insider.uid);
    const blocked = await createTask('Carries an outsider', outsider.uid);
    const last = await createTask('Also moves cleanly', insider.uid);

    const res = await owner.api.post(`${T()}/bulk-matter`)
      .send({ taskIds: [first, blocked, last], matterId });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(res.body.failed).toEqual([blocked]);
    // Byte-identical to what the per-task check produced: the message names the
    // colleague who is not on the matter, which is what tells the user what to fix.
    expect(res.body.errors[blocked]).toBe(
      `Add ${await displayName(outsider.uid)} to this matter before assigning them work on it`,
    );
    expect(await matterOf(first)).toBe(matterId);
    expect(await matterOf(blocked)).toBeNull();
    expect(await matterOf(last)).toBe(matterId);
  });

  it('reports the reminder recipient when they are the outsider', async () => {
    const task = await owner.api.post(T()).send({
      title: 'Outside reminder recipient',
      dueDate: '2026-10-01',
      assignedTo: [insider.uid],
      reminderRecipientIds: [outsider.uid],
    });
    expect(task.status).toBe(201);
    const taskId = task.body.taskId as string;

    const res = await owner.api.post(`${T()}/bulk-matter`).send({ taskIds: [taskId], matterId });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
    expect(res.body.errors[taskId]).toBe(
      `Add ${await displayName(outsider.uid)} to this matter before assigning them work on it`,
    );
    expect(await matterOf(taskId)).toBeNull();
  });
});

describe('bulk matter connection use', () => {
  it('makes the same pool checkouts for ten tasks as for two', async () => {
    const warmUp = await createTask('Warm-up', insider.uid);
    const two = [await createTask('Two 1', insider.uid), await createTask('Two 2', insider.uid)];
    const ten: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ten.push(await createTask(`Ten ${i}`, insider.uid));
    }
    await drainEvents();

    // The calendar and notification listeners run detached after the emit and
    // query on their own schedule. They are not this request's work, and leaving
    // them attached would hide whether the request itself grows with the count.
    const listeners = eventBus.listeners(TASK_UPDATED);
    eventBus.removeAllListeners(TASK_UPDATED);
    try {
      // The first call warms the permission and membership caches, so the two
      // measured calls below take the same middleware path.
      expect((await owner.api.post(`${T()}/bulk-matter`)
        .send({ taskIds: [warmUp], matterId })).status).toBe(200);

      const small = await checkoutsDuring(() => owner.api.post(`${T()}/bulk-matter`)
        .send({ taskIds: two, matterId }));
      const large = await checkoutsDuring(() => owner.api.post(`${T()}/bulk-matter`)
        .send({ taskIds: ten, matterId }));

      expect(small.result.status).toBe(200);
      expect(small.result.body.updated).toBe(2);
      expect(large.result.status).toBe(200);
      expect(large.result.body.updated).toBe(10);
      // Proves the listener sees the request's queries at all, so the equality
      // below is a measurement rather than two zeros.
      expect(small.total).toBeGreaterThanOrEqual(3);
      // One membership query per task would add eight checkouts here. Two spare
      // checkouts absorb a stray background write from an earlier request that
      // lands inside the window under a loaded full-suite run; they are far below
      // the eight a per-task query adds, so that regression still fails.
      expect(large.total).toBeLessThanOrEqual(small.total + 2);
      expect(large.peak).toBeLessThanOrEqual(3);
    } finally {
      listeners.forEach((listener: any) => eventBus.on(TASK_UPDATED, listener));
    }
  });
});

export {};
