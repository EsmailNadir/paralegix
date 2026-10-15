/**
 * The task or event a time entry says it was logged from.
 *
 * `sourceTaskId` is what lets the task page show the hours spent on it, and it is
 * the one reference on a time entry that points at work belonging to somebody
 * else's context. The rule is in `resolveSourceMetadata`: a task is accepted only
 * when it belongs to the context the entry is billed to (the matter, or a client
 * attached to the task), or when it has no context of its own. An event is only
 * valid against a matter. Nothing exercised those branches through the route, so a
 * loosened check would have attached billable time to another matter's task, or
 * another firm's, without a single assertion noticing.
 *
 * Each refusal asserts the status AND that no time row was written. Red if any
 * branch of `resolveSourceMetadata` is dropped or loosened.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter } from '../support/matters';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let otherClient: ClientRecord;
let matterId: string;
let otherMatterId: string;

const base = () => `/api/lawfirms/${firm.id}/billing/time-entries`;

const timeRows = async () => (await testPool.query(
  `select count(*)::int n from activities where kind = 'time' and law_firm_id = $1`, [firm.id],
)).rows[0].n as number;

async function seedTask(opts: { firmId?: string; matterId?: string | null; clientId?: string | null } = {}) {
  const lawFirmId = opts.firmId ?? firm.id;
  const { rows } = await testPool.query(
    `insert into tasks (law_firm_id, matter_id, title) values ($1, $2, 'Source task') returning id`,
    [lawFirmId, opts.matterId ?? null],
  );
  if (opts.clientId) {
    await testPool.query(
      'insert into task_clients (law_firm_id, task_id, client_id) values ($1, $2, $3)',
      [lawFirmId, rows[0].id, opts.clientId],
    );
  }
  return rows[0].id as string;
}

const logTime = (context: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  owner.api.post(base()).send({
    ...context, userId: owner.uid, hours: 1, date: '2026-03-10', description: 'Work', hourlyRate: 250, ...extra,
  });

const sourceOf = async (id: string) => (await testPool.query(
  'select source_task_id, source_event_id from activities where id = $1', [id],
)).rows[0];

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Billed Client' });
  otherClient = await createPersonClient(firm.id, { name: 'Other Client' });
  matterId = await seedMatter(firm.id, { name: 'Billed matter', memberUids: [owner.uid], clientIds: [client.id] });
  otherMatterId = await seedMatter(firm.id, { name: 'Other matter', memberUids: [owner.uid], clientIds: [otherClient.id] });
});

describe('a time entry on a matter', () => {
  it('accepts a task on that matter and records it as the source', async () => {
    const task = await seedTask({ matterId });

    const res = await logTime({ matterId }, { sourceTaskId: task });

    expect(res.status).toBe(201);
    expect((await sourceOf(res.body.timeEntry.id)).source_task_id).toBe(task);
  });

  it('accepts a task that has no matter and no client of its own', async () => {
    const task = await seedTask();

    const res = await logTime({ matterId }, { sourceTaskId: task });

    expect(res.status).toBe(201);
    expect((await sourceOf(res.body.timeEntry.id)).source_task_id).toBe(task);
  });

  it('refuses a task on another matter, and writes nothing', async () => {
    const task = await seedTask({ matterId: otherMatterId });

    const res = await logTime({ matterId }, { sourceTaskId: task });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Task does not belong to the selected billing context');
    expect(await timeRows()).toBe(0);
  });

  it("refuses another firm's task, and writes nothing", async () => {
    const stranger = await createFirm();
    const task = await seedTask({ firmId: stranger.id });

    const res = await logTime({ matterId }, { sourceTaskId: task });

    expect(res.status).toBe(400);
    expect(await timeRows()).toBe(0);
  });

  it('refuses a task id that names nothing', async () => {
    const res = await logTime({ matterId }, { sourceTaskId: randomUUID() });

    expect(res.status).toBe(400);
    expect(await timeRows()).toBe(0);
  });

  it('refuses a task and an event together', async () => {
    const task = await seedTask({ matterId });

    const res = await logTime({ matterId }, { sourceTaskId: task, sourceEventId: randomUUID() });

    expect(res.status).toBe(400);
    expect(await timeRows()).toBe(0);
  });

  it("accepts the matter's own event, and refuses an event of another matter", async () => {
    const event = async (matter: string) => (await testPool.query(
      `insert into events (law_firm_id, matter_id, title, date) values ($1, $2, 'Hearing', now()) returning id`,
      [firm.id, matter],
    )).rows[0].id as string;

    const ok = await logTime({ matterId }, { sourceEventId: await event(matterId) });
    expect(ok.status).toBe(201);
    expect(await timeRows()).toBe(1);

    const wrong = await logTime({ matterId }, { sourceEventId: await event(otherMatterId) });
    expect(wrong.status).toBe(400);
    expect(await timeRows()).toBe(1);
  });
});

describe('a time entry on a client', () => {
  it('accepts a task the client is attached to', async () => {
    const task = await seedTask({ clientId: client.id });

    const res = await logTime({ clientId: client.id }, { sourceTaskId: task });

    expect(res.status).toBe(201);
    expect((await sourceOf(res.body.timeEntry.id)).source_task_id).toBe(task);
  });

  it('accepts a task with no context of its own', async () => {
    const task = await seedTask();

    const res = await logTime({ clientId: client.id }, { sourceTaskId: task });

    expect(res.status).toBe(201);
  });

  it('refuses a task attached to a different client, and writes nothing', async () => {
    const task = await seedTask({ clientId: otherClient.id });

    const res = await logTime({ clientId: client.id }, { sourceTaskId: task });

    expect(res.status).toBe(400);
    expect(await timeRows()).toBe(0);
  });

  it("accepts a matter task when the client is one of that matter's clients, and refuses one when it is not", async () => {
    // A matter task's clients are its matter's clients, so that is what the
    // client context is matched against.
    const onClientsMatter = await seedTask({ matterId });
    const onOtherMatter = await seedTask({ matterId: otherMatterId });

    const ok = await logTime({ clientId: client.id }, { sourceTaskId: onClientsMatter });
    expect(ok.status).toBe(201);
    expect(await timeRows()).toBe(1);

    const wrong = await logTime({ clientId: client.id }, { sourceTaskId: onOtherMatter });
    expect(wrong.status).toBe(400);
    expect(await timeRows()).toBe(1);
  });

  it('refuses an event source, which only a matter can have, and writes nothing', async () => {
    const event = (await testPool.query(
      `insert into events (law_firm_id, matter_id, title, date) values ($1, $2, 'Hearing', now()) returning id`,
      [firm.id, matterId],
    )).rows[0].id as string;

    const res = await logTime({ clientId: client.id }, { sourceEventId: event });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Events can only be logged against a matter');
    expect(await timeRows()).toBe(0);
  });
});
