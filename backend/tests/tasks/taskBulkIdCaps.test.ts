/**
 * How many ids the bulk STATUS, bulk MATTER and bulk DELETE routes take.
 *
 * The tasks grid answers "select all" from GET /tasks/ids and sends that answer
 * straight to a bulk route, so the cap on a bulk body and the ceiling on a
 * select-all answer are the same number by design. Status and matter once had
 * `.min(1)` and no ceiling at all, so one request could hand the service an
 * unbounded id list and every query and event built from it.
 *
 * A body over the cap must be refused by validation, before anything is written:
 * a bulk route that half-applies an oversized selection is worse than one that
 * refuses it.
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

let firm: Firm;
let owner: Actor;
let matterId: string;

const T = () => `/api/lawfirms/${firm.id}/tasks`;

async function createTask(title: string) {
  const res = await owner.api.post(T()).send({ title });
  expect(res.status).toBe(201);
  return res.body.taskId as string;
}

async function taskRow(taskId: string) {
  const { rows } = await testPool.query(
    'select status, matter_id from tasks where law_firm_id = $1 and id = $2',
    [firm.id, taskId],
  );
  return rows[0];
}

/** The ceiling the select-all endpoint applies, read from the route itself. */
async function selectAllCeiling() {
  const res = await owner.api.get(`${T()}/ids`);
  expect(res.status).toBe(200);
  expect(res.body.limit).toBeGreaterThan(0);
  return res.body.limit as number;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: 'Pat Person' });
  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Destination Matter',
    clients: [{ clientId: client.id, name: 'Pat Person' }],
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;
  await drainEvents();
});

/** `size` ids: one real task first, then random ids that match nothing. */
const idsOfLength = (taskId: string, size: number) =>
  [taskId, ...Array.from({ length: size - 1 }, () => randomUUID())];

interface BulkRoute {
  path: string;
  body: () => Record<string, unknown>;
  countKey: string;
  /** Asserts the real task after the route ran, `changed` saying whether it should have. */
  check: (taskId: string, changed: boolean) => Promise<void>;
}

const ROUTES: [string, BulkRoute][] = [
  ['bulk status', {
    path: 'bulk-status',
    body: () => ({ status: 'completed' }),
    countKey: 'updated',
    check: async (taskId, changed) => {
      expect((await taskRow(taskId)).status).toBe(changed ? 'completed' : 'open');
    },
  }],
  ['bulk matter move', {
    path: 'bulk-matter',
    body: () => ({ matterId }),
    countKey: 'updated',
    check: async (taskId, changed) => {
      expect((await taskRow(taskId)).matter_id).toBe(changed ? matterId : null);
    },
  }],
  ['bulk delete', {
    path: 'bulk-delete',
    body: () => ({}),
    countKey: 'deleted',
    check: async (taskId, changed) => {
      expect(await taskRow(taskId)).toEqual(changed ? undefined : expect.anything());
    },
  }],
];

describe.each(ROUTES)('how many ids one %s takes', (_label, route) => {
  it('accepts as many ids as "select all" can hand the grid', async () => {
    const task = await createTask('Selected');
    const limit = await selectAllCeiling();

    const res = await owner.api.post(`${T()}/${route.path}`)
      .send({ ...route.body(), taskIds: idsOfLength(task, limit) });

    // The grid sends the select-all answer straight to this route, so a cap
    // below that ceiling would turn a full selection into a 400.
    expect(res.status).toBe(200);
    expect(res.body[route.countKey]).toBe(1);
    await route.check(task, true);
  });

  it('refuses one id more than that, before changing anything', async () => {
    const task = await createTask('Selected');
    const limit = await selectAllCeiling();

    const res = await owner.api.post(`${T()}/${route.path}`)
      .send({ ...route.body(), taskIds: idsOfLength(task, limit + 1) });

    expect(res.status).toBe(400);
    // Nothing was written: the real task in the oversized body is untouched.
    await route.check(task, false);
  });
});

export {};
