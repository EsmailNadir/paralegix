/**
 * POST /api/lawfirms/:lawFirmId/tasks/bulk-delete: what a bulk delete hands the
 * file sweep, and how many pool connections it takes to do it. How many ids one
 * request may carry is pinned with the other bulk routes in
 * `taskBulkIdCaps.test.ts`.
 *
 * Deleting a task cascades its `files` rows away, and nothing afterwards can name
 * the stored objects those rows pointed at. The delete therefore snapshots each
 * task's documents first, puts that snapshot on the task's TASK_DELETED event and
 * sweeps the objects inside the request. A snapshot attributed to the wrong task,
 * or missing for one, leaves objects in the bucket that the firm keeps being
 * charged for.
 *
 * Every request on an instance shares one small pool (12 connections against a
 * Supabase session pooler that allows 15). "Select all" can put thousands of ids
 * in one bulk delete, so the work per request has to stay a fixed number of
 * queries rather than one per task.
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
import { gateMethod } from '../support/gate';

// The sweep deletes real objects, so it needs a bucket that holds them.
installInMemoryBucket();

// Loaded after the harness, which points DATABASE_URL at this worker's test
// database: `db.ts` reads the URL when it is first imported.
const { pool } = require('../../src/shared/database/db');
const eventBus = require('../../src/shared/events/eventBus');
const { TASK_DELETED } = require('../../src/shared/events/eventTypes');
const tasksRepo = require('../../src/modules/tasks/tasks.repository');

let firm: Firm;
let owner: Actor;
let matterId: string;

const T = () => `/api/lawfirms/${firm.id}/tasks`;

async function createTask(title: string, extra: Record<string, unknown> = { matterId: undefined }) {
  const res = await owner.api.post(T()).send({ title, matterId, ...extra });
  expect(res.status).toBe(201);
  return (res.body.taskId ?? res.body.task?.id) as string;
}

/** The scope root a task's documents hang off, as the upload route builds it. */
async function seedTaskRoot(taskId: string, taskMatterId: string | null) {
  const { rows } = await testPool.query(
    `insert into files (law_firm_id, kind, name, scope, matter_id, task_id)
     values ($1, 'folder', '', 'task', $2, $3) returning id`,
    [firm.id, taskMatterId, taskId],
  );
  return rows[0].id as string;
}

async function seedTaskFile(rootId: string, taskId: string, taskMatterId: string | null, opts: {
  name: string; bytes: number; finalized?: boolean; deleted?: boolean;
}) {
  const objectPath = `lawfirmids/${firm.id}/objects/${randomUUID()}`;
  await testPool.query(
    `insert into files (law_firm_id, kind, name, parent_id, scope, matter_id, task_id,
                        object_path, mime_type, size_bytes, finalized_at, deleted_at)
     values ($1, 'file', $2, $3, 'task', $4, $5, $6, 'application/pdf', $7, $8, $9)`,
    [firm.id, opts.name, rootId, taskMatterId, taskId, objectPath, opts.bytes,
      opts.finalized === false ? null : new Date(), opts.deleted ? new Date() : null],
  );
  putObject(objectPath, { bytes: opts.bytes });
  return objectPath;
}

const byPath = (snapshot: any) => ({
  objects: [...(snapshot?.objects ?? [])]
    .sort((x: any, y: any) => x.objectPath.localeCompare(y.objectPath)),
});

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
  objects.clear();
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: 'Pat Person' });
  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Host Matter',
    clients: [{ clientId: client.id, name: 'Pat Person' }],
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;
  await drainEvents();
});

describe('bulk delete and the file sweep', () => {
  it('publishes deletion only after the bulk database write succeeds', async () => {
    const taskId = await createTask('Wait for delete');
    const gate = gateMethod(tasksRepo, 'batchDelete');
    let published = false;
    const listener = ({ taskId: deletedId }: { taskId: string }) => {
      if (deletedId === taskId) published = true;
    };
    eventBus.on(TASK_DELETED, listener);
    let pending: Promise<any> | null = null;
    try {
      async function fire() { return owner.api.post(`${T()}/bulk-delete`).send({ taskIds: [taskId] }); }
      pending = fire();
      await gate.arrived(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(published).toBe(false);
      gate.open();
      const res = await pending;
      expect(res.status).toBe(200);
      await drainEvents();
      expect(published).toBe(true);
    } finally {
      gate.restore();
      if (pending) await pending;
      eventBus.off(TASK_DELETED, listener);
    }
  });

  it('keeps the task and emits no deletion when the bulk database write fails', async () => {
    const taskId = await createTask('Keep on write failure');
    const gate = gateMethod(tasksRepo, 'batchDelete');
    let published = false;
    const listener = ({ taskId: deletedId }: { taskId: string }) => {
      if (deletedId === taskId) published = true;
    };
    eventBus.on(TASK_DELETED, listener);
    try {
      gate.failNext(new Error('Database write failed'));
      const res = await owner.api.post(`${T()}/bulk-delete`).send({ taskIds: [taskId] });
      expect(res.status).toBe(500);
      await drainEvents();
      expect(published).toBe(false);
      const { rows } = await testPool.query('select id from tasks where id = $1', [taskId]);
      expect(rows).toHaveLength(1);
    } finally {
      gate.restore();
      eventBus.off(TASK_DELETED, listener);
    }
  });

  it('hands each deleted task its own documents and removes their rows and objects', async () => {
    const matterTask = await createTask('Matter task');
    const firmTask = await createTask('Firm task', { matterId: undefined });
    const bareTask = await createTask('No documents');
    const keptTask = await createTask('Not deleted');

    const matterRoot = await seedTaskRoot(matterTask, matterId);
    const charged = await seedTaskFile(matterRoot, matterTask, matterId, { name: 'charged.pdf', bytes: 2048 });
    // An upload that never finished was never charged, but its bytes are still
    // in the bucket and have to be swept.
    const unfinished = await seedTaskFile(matterRoot, matterTask, matterId,
      { name: 'unfinished.pdf', bytes: 512, finalized: false });
    // A folder has no object, so it must not appear in the snapshot.
    await testPool.query(
      `insert into files (law_firm_id, kind, name, parent_id, scope, matter_id, task_id)
       values ($1, 'folder', 'Drafts', $2, 'task', $3, $4)`,
      [firm.id, matterRoot, matterId, matterTask],
    );

    const firmRoot = await seedTaskRoot(firmTask, null);
    const live = await seedTaskFile(firmRoot, firmTask, null, { name: 'live.pdf', bytes: 4096 });
    // Soft-deleted was already credited back, so it carries zero bytes.
    const binned = await seedTaskFile(firmRoot, firmTask, null,
      { name: 'binned.pdf', bytes: 1000, deleted: true });

    const keptRoot = await seedTaskRoot(keptTask, matterId);
    const keptObject = await seedTaskFile(keptRoot, keptTask, matterId, { name: 'kept.pdf', bytes: 300 });
    await drainEvents();

    const emitted = new Map<string, any>();
    const capture = (payload: any) => { emitted.set(payload.taskId, payload.files); };
    eventBus.on(TASK_DELETED, capture);
    let res: any;
    try {
      res = await owner.api.post(`${T()}/bulk-delete`)
        .send({ taskIds: [matterTask, firmTask, bareTask] });
    } finally {
      eventBus.off(TASK_DELETED, capture);
    }

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(3);
    expect([...emitted.keys()].sort()).toEqual([matterTask, firmTask, bareTask].sort());
    // Each task's event names exactly its own documents with what the firm is
    // still charged for each. Swapping two tasks' sets, or dropping the empty one,
    // breaks the per-task storage credit the listeners and the sweep rely on.
    expect(byPath(emitted.get(matterTask))).toEqual(byPath({ objects: [
      { objectPath: charged, chargedBytes: 2048 },
      { objectPath: unfinished, chargedBytes: 0 },
    ] }));
    expect(byPath(emitted.get(firmTask))).toEqual(byPath({ objects: [
      { objectPath: live, chargedBytes: 4096 },
      { objectPath: binned, chargedBytes: 0 },
    ] }));
    expect(emitted.get(bareTask)).toEqual({ objects: [] });

    const { rows: taskRows } = await testPool.query(
      'select id from tasks where law_firm_id = $1', [firm.id]);
    expect(taskRows.map((r: any) => r.id)).toEqual([keptTask]);
    const { rows: fileRows } = await testPool.query(
      'select task_id from files where law_firm_id = $1 and kind = $2', [firm.id, 'file']);
    expect(fileRows.map((r: any) => r.task_id)).toEqual([keptTask]);

    // The sweep runs inside the request, so the objects are gone by the response.
    expect(objects.has(charged)).toBe(false);
    expect(objects.has(unfinished)).toBe(false);
    expect(objects.has(live)).toBe(false);
    expect(objects.has(binned)).toBe(false);
    expect(objects.has(keptObject)).toBe(true);
  });
});

describe('bulk delete connection use', () => {
  it('makes the same pool checkouts for ten tasks as for two', async () => {
    const warmUp = await createTask('Warm-up');
    const two = [await createTask('Two 1'), await createTask('Two 2')];
    const ten: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ten.push(await createTask(`Ten ${i}`));
    }
    await drainEvents();

    // The calendar and notification listeners run detached after the emit and
    // query once per task on their own schedule. They are not this request's
    // work, and leaving them attached would hide whether the request itself
    // grows with the task count.
    const listeners = eventBus.listeners(TASK_DELETED);
    eventBus.removeAllListeners(TASK_DELETED);
    try {
      // The first call warms the permission and membership caches, so the two
      // measured calls below take the same middleware path.
      expect((await owner.api.post(`${T()}/bulk-delete`).send({ taskIds: [warmUp] })).status)
        .toBe(200);

      const small = await checkoutsDuring(() => owner.api.post(`${T()}/bulk-delete`)
        .send({ taskIds: two }));
      const large = await checkoutsDuring(() => owner.api.post(`${T()}/bulk-delete`)
        .send({ taskIds: ten }));

      expect(small.result.status).toBe(200);
      expect(small.result.body.deleted).toBe(2);
      expect(large.result.status).toBe(200);
      expect(large.result.body.deleted).toBe(10);
      // Proves the listener sees the request's queries at all, so the equality
      // below is a measurement rather than two zeros.
      expect(small.total).toBeGreaterThanOrEqual(3);
      // One snapshot query per task would add eight checkouts here. Two spare
      // checkouts absorb a stray background write from an earlier request that
      // lands inside the window under a loaded full-suite run; they are far
      // below the eight a per-task query adds, so that regression still fails.
      expect(large.total).toBeLessThanOrEqual(small.total + 2);
      expect(large.peak).toBeLessThanOrEqual(3);
    } finally {
      listeners.forEach((listener: any) => eventBus.on(TASK_DELETED, listener));
    }
  });
});
