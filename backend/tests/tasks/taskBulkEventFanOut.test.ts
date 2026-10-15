/**
 * How many listener chains the three bulk task routes start at once.
 *
 * Each of bulk-delete, bulk-status and bulk-matter emits one domain event per
 * task. `eventBus.emit` does not await its listeners, so emitting in a bare loop
 * over a "select all" selection starts thousands of listener chains in the same
 * tick, each with its own queries, against the twelve connections an instance
 * shares across every request in flight. The bulk-delete connection test had to
 * detach the listeners to measure the request at all, which is the symptom.
 *
 * The fan-out is therefore bounded: at most a few chains run at once. It stays
 * DETACHED, because awaiting five thousand listener chains three at a time would
 * outlast any request budget; the route's job is the write and the response, and
 * the listeners are consequences of it. Both halves are pinned here, since either
 * one alone is the wrong design.
 */
import {
  drainEvents,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const eventBus = require('../../src/shared/events/eventBus');
const { TASK_UPDATED, TASK_DELETED } = require('../../src/shared/events/eventTypes');

/** The width the bulk producers bound their listener fan-out to. */
const EXPECTED_WIDTH = 3;
/** Enough tasks that an unbounded emit is unmistakable next to a bounded one. */
const TASK_COUNT = 9;

let firm: Firm;
let owner: Actor;
let matterId: string;

const T = () => `/api/lawfirms/${firm.id}/tasks`;

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitUntil(done: () => boolean, label: string) {
  for (let i = 0; i < 400; i += 1) {
    if (done()) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Replace every listener for `eventName` with one probe that holds its slot for a
 * measurable time, run `work`, and report how many probe chains overlapped.
 *
 * The app's own calendar and notification listeners are detached for the
 * measurement: they are extra chains per event, so leaving them attached would
 * measure the app's listener count rather than the producer's fan-out width.
 */
async function measureFanOut(eventName: string, work: () => Promise<any>) {
  const seen: any[] = [];
  let active = 0;
  let peak = 0;
  const probe = async (payload: any) => {
    active += 1;
    peak = Math.max(peak, active);
    // Long enough that a same-tick fan-out overlaps every chain, and that a
    // bounded one cannot finish a slot before the next chain is admitted.
    await sleep(40);
    seen.push(payload);
    active -= 1;
  };

  const existing = eventBus.listeners(eventName);
  eventBus.removeAllListeners(eventName);
  eventBus.on(eventName, probe);
  try {
    const result = await work();
    const seenAtResponse = seen.length;
    await waitUntil(() => seen.length >= TASK_COUNT, `${eventName} fan-out to finish`);
    return { result, peak, seen, seenAtResponse };
  } finally {
    eventBus.off(eventName, probe);
    existing.forEach((listener: any) => eventBus.on(eventName, listener));
  }
}

async function createTasks(count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await owner.api.post(T()).send({ title: `Bulk subject ${i}` });
    expect(res.status).toBe(201);
    ids.push(res.body.taskId as string);
  }
  await drainEvents();
  return ids;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Destination Matter',
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;
  await drainEvents();
});

describe('bulk status update event fan-out', () => {
  it('runs at most a few listener chains at once and delivers every task once', async () => {
    const taskIds = await createTasks(TASK_COUNT);

    const { result, peak, seen, seenAtResponse } = await measureFanOut(
      TASK_UPDATED,
      () => owner.api.post(`${T()}/bulk-status`).send({ taskIds, status: 'completed' }),
    );

    expect(result.status).toBe(200);
    expect(result.body.updated).toBe(TASK_COUNT);
    // The point of the change: nine tasks must not put nine listener chains in
    // flight at the same instant.
    expect(peak).toBeLessThanOrEqual(EXPECTED_WIDTH);
    // ...and the route must not pay for them. Waiting on nine chains three at a
    // time would have delivered several before responding.
    expect(seenAtResponse).toBe(0);
    // Same payload as an unbounded emit produced: one event per task, carrying
    // the post-write entity and the assignee snapshot the listeners diff against.
    expect(seen.map((p) => p.taskId).sort()).toEqual([...taskIds].sort());
    seen.forEach((payload) => {
      expect(payload.entityData.status).toBe('completed');
      expect(payload.previousData).toEqual({ assignedTo: [] });
    });
  });
});

describe('bulk matter move event fan-out', () => {
  it('runs at most a few listener chains at once and delivers every task once', async () => {
    const taskIds = await createTasks(TASK_COUNT);

    const { result, peak, seen, seenAtResponse } = await measureFanOut(
      TASK_UPDATED,
      () => owner.api.post(`${T()}/bulk-matter`).send({ taskIds, matterId }),
    );

    expect(result.status).toBe(200);
    expect(result.body.updated).toBe(TASK_COUNT);
    expect(peak).toBeLessThanOrEqual(EXPECTED_WIDTH);
    expect(seenAtResponse).toBe(0);
    expect(seen.map((p) => p.taskId).sort()).toEqual([...taskIds].sort());
    seen.forEach((payload) => expect(payload.entityData.matterId).toBe(matterId));
  });
});

describe('bulk delete event fan-out', () => {
  it('runs at most a few listener chains at once and delivers every task once', async () => {
    const taskIds = await createTasks(TASK_COUNT);

    const { result, peak, seen, seenAtResponse } = await measureFanOut(
      TASK_DELETED,
      () => owner.api.post(`${T()}/bulk-delete`).send({ taskIds }),
    );

    expect(result.status).toBe(200);
    expect(result.body.deleted).toBe(TASK_COUNT);
    expect(peak).toBeLessThanOrEqual(EXPECTED_WIDTH);
    expect(seenAtResponse).toBe(0);
    expect(seen.map((p) => p.taskId).sort()).toEqual([...taskIds].sort());
    // The file sweep reads this snapshot; a task with no documents still carries
    // an empty one rather than nothing.
    seen.forEach((payload) => expect(payload.files).toEqual({ objects: [] }));
  });
});

export {};
