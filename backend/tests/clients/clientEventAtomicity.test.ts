/**
 * A standalone client event is several writes: the `events` row, its assignee
 * rows, its contact rows. They commit together or not at all, and the bus
 * event that drives calendar sync goes out only once they have committed, the
 * same contract `matterEvents.service.ts` keeps for matter events.
 *
 * The failure is injected by making a LATER step throw (the assignee or
 * contact sync), which is the shape of a real mid-write failure: the row
 * insert has already run when the error arrives.
 */
import {
  createFirm,
  createPersonClient,
  drainEvents,
  ownerOf,
  testPool,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';

const clientEventsRepo = require('../../src/modules/clients/clientEvents.repository');
const eventBus = require('../../src/shared/events/eventBus');
const {
  CLIENT_EVENT_CREATED,
  CLIENT_EVENT_UPDATED,
  CLIENT_EVENT_DELETED,
} = require('../../src/shared/events/eventTypes');
const { pool: appPool } = require('../../src/shared/database/db');

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let emitted: string[];
let emitSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

const eventsPath = () => `/api/lawfirms/${firm.id}/clients/${client.id}/events`;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Atomic client' });
  emitted = [];
  const realEmit = eventBus.emit.bind(eventBus);
  emitSpy = jest.spyOn(eventBus, 'emit').mockImplementation((...args: any[]) => {
    emitted.push(args[0]);
    return realEmit(...args);
  });
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await drainEvents();
  emitSpy.mockRestore();
  errorSpy.mockRestore();
  jest.restoreAllMocks();
});

const eventRows = async (title: string) => (await testPool.query(
  'select id, title from events where law_firm_id = $1 and client_id = $2 and title = $3',
  [firm.id, client.id, title],
)).rows;

/**
 * Records, in order, every COMMIT the app's pg clients send and every bus
 * emit, so a spec can say which came first. `emit` is synchronous, so an emit
 * made inside an open transaction lands in this log BEFORE that transaction's
 * COMMIT; one deferred until after the commit lands after it.
 */
function recordCommitOrder() {
  const log: string[] = [];
  const record = (config: any) => {
    const text = typeof config === 'string' ? config : config?.text;
    if (typeof text !== 'string') return;
    if (/^\s*commit\b/i.test(text)) log.push('commit');
    else if (/^\s*insert into "events"/i.test(text)) log.push('insert:events');
    else if (/^\s*delete from "events"/i.test(text)) log.push('delete:events');
  };
  // `queryInstrumentation.ts` binds each client's `query` when it is checked
  // out, so the statements are observed by wrapping the checkout, per client.
  const realConnect = appPool.connect;
  const wrapped = new Map<any, any>();
  const wrapClient = (client: any) => {
    if (client && !wrapped.has(client)) {
      const inner = client.query;
      wrapped.set(client, inner);
      client.query = function recorded(this: any, ...args: any[]) {
        record(args[0]);
        return inner.apply(this, args);
      };
    }
    return client;
  };
  appPool.connect = function connect(this: any, ...args: any[]) {
    if (typeof args[0] === 'function') {
      const callback = args[0];
      return realConnect.call(this, (err: any, client: any, release: any) => callback(err, err ? client : wrapClient(client), release));
    }
    return realConnect.apply(this, args).then(wrapClient);
  };
  emitSpy.mockImplementation((...args: any[]) => {
    emitted.push(args[0]);
    log.push(`emit:${args[0]}`);
    return true;
  });
  return {
    log,
    restore: () => {
      appPool.connect = realConnect;
      for (const [client, inner] of wrapped) client.query = inner;
    },
  };
}

describe('client event create', () => {
  /**
   * Goes red if the create is not one transaction: the `events` row is
   * inserted, the assignee sync then throws, and the row is left behind as an
   * event with no assignees that no one asked for.
   */
  test('a failure after the row is inserted leaves no client event and emits nothing', async () => {
    const original = clientEventsRepo.syncAssignees;
    let reached = false;
    jest.spyOn(clientEventsRepo, 'syncAssignees').mockImplementation(async (...args: any[]) => {
      reached = true;
      await original.apply(clientEventsRepo, args);
      throw new Error('Injected assignee sync failure');
    });

    const res = await owner.api.post(eventsPath()).send({
      type: 'meeting', title: 'Doomed intake', date: '2026-11-04', allDay: true, assignedTo: [owner.uid],
    });

    expect(reached).toBe(true);
    expect(res.status).toBe(500);
    expect(await eventRows('Doomed intake')).toEqual([]);
    expect(emitted).not.toContain(CLIENT_EVENT_CREATED);
  });

  /**
   * Goes red if CLIENT_EVENT_CREATED is emitted inside the transaction (its
   * calendar-sync listener would read a row that may still roll back) or more
   * than once.
   */
  test('a successful create emits CLIENT_EVENT_CREATED exactly once, after the commit', async () => {
    const order = recordCommitOrder();
    let res;
    try {
      res = await owner.api.post(eventsPath()).send({
        type: 'meeting', title: 'Committed intake', date: '2026-11-04', allDay: true, assignedTo: [owner.uid],
      });
    } finally {
      order.restore();
    }

    expect(res.status).toBe(201);
    expect(await eventRows('Committed intake')).toHaveLength(1);
    expect(emitted.filter((e) => e === CLIENT_EVENT_CREATED)).toHaveLength(1);
    const insertAt = order.log.indexOf('insert:events');
    const emitAt = order.log.indexOf(`emit:${CLIENT_EVENT_CREATED}`);
    expect(insertAt).toBeGreaterThanOrEqual(0);
    const commitAfterInsert = order.log.indexOf('commit', insertAt);
    expect(commitAfterInsert).toBeGreaterThan(insertAt);
    expect(emitAt).toBeGreaterThan(commitAfterInsert);
  });
});

describe('client event update', () => {
  /**
   * Goes red if the update is not one transaction: the title change commits,
   * the contact sync then throws, and the caller gets a 500 for an edit that
   * half happened.
   */
  test('a failure after the row is updated leaves the event as it was and emits nothing', async () => {
    const created = await owner.api.post(eventsPath()).send({
      type: 'meeting', title: 'Original title', date: '2026-11-04', allDay: true,
    });
    expect(created.status).toBe(201);
    const eventId = created.body.eventId;
    emitted.length = 0;

    const original = clientEventsRepo.syncContacts;
    let reached = false;
    jest.spyOn(clientEventsRepo, 'syncContacts').mockImplementation(async (...args: any[]) => {
      reached = true;
      await original.apply(clientEventsRepo, args);
      throw new Error('Injected contact sync failure');
    });

    const res = await owner.api.put(`${eventsPath()}/${eventId}`).send({
      source: 'client', title: 'Edited title', assignedTo: [owner.uid], contactIds: [],
    });

    expect(reached).toBe(true);
    expect(res.status).toBe(500);
    expect(await eventRows('Original title')).toHaveLength(1);
    expect(await eventRows('Edited title')).toEqual([]);
    const { rows: assignees } = await testPool.query(
      'select user_id from event_assignees where law_firm_id = $1 and event_id = $2',
      [firm.id, eventId],
    );
    expect(assignees).toEqual([]);
    expect(emitted).not.toContain(CLIENT_EVENT_UPDATED);
  });

  /** Goes red if CLIENT_EVENT_UPDATED is emitted before the update commits. */
  test('a successful update emits CLIENT_EVENT_UPDATED exactly once, after the commit', async () => {
    const created = await owner.api.post(eventsPath()).send({
      type: 'meeting', title: 'Before edit', date: '2026-11-04', allDay: true,
    });
    expect(created.status).toBe(201);
    await drainEvents();
    emitted.length = 0;

    const order = recordCommitOrder();
    let res;
    try {
      res = await owner.api.put(`${eventsPath()}/${created.body.eventId}`).send({
        source: 'client', title: 'After edit', assignedTo: [owner.uid],
      });
    } finally {
      order.restore();
    }

    expect(res.status).toBe(200);
    expect(await eventRows('After edit')).toHaveLength(1);
    expect(emitted.filter((e) => e === CLIENT_EVENT_UPDATED)).toHaveLength(1);
    const emitAt = order.log.indexOf(`emit:${CLIENT_EVENT_UPDATED}`);
    const lastCommit = order.log.lastIndexOf('commit');
    expect(lastCommit).toBeGreaterThanOrEqual(0);
    expect(emitAt).toBeGreaterThan(lastCommit);
  });
});

describe('client event delete', () => {
  /** Goes red if CLIENT_EVENT_DELETED is emitted before the delete commits. */
  test('a successful delete removes the row and emits CLIENT_EVENT_DELETED once, after the commit', async () => {
    const created = await owner.api.post(eventsPath()).send({
      type: 'meeting', title: 'To delete', date: '2026-11-04', allDay: true,
    });
    expect(created.status).toBe(201);
    await drainEvents();
    emitted.length = 0;

    const order = recordCommitOrder();
    let res;
    try {
      res = await owner.api.delete(`${eventsPath()}/${created.body.eventId}`);
    } finally {
      order.restore();
    }

    expect(res.status).toBe(200);
    expect(await eventRows('To delete')).toEqual([]);
    expect(emitted.filter((e) => e === CLIENT_EVENT_DELETED)).toHaveLength(1);
    const deleteAt = order.log.indexOf('delete:events');
    const commitAfterDelete = order.log.indexOf('commit', deleteAt);
    expect(deleteAt).toBeGreaterThanOrEqual(0);
    expect(commitAfterDelete).toBeGreaterThan(deleteAt);
    expect(order.log.indexOf(`emit:${CLIENT_EVENT_DELETED}`)).toBeGreaterThan(commitAfterDelete);
  });
});

export {};
