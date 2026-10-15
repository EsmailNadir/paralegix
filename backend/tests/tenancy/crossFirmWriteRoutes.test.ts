/**
 * B02 A02/A03, for WRITE routes specifically.
 *
 * `tenancy.test.ts` proves both directions of the tenancy boundary, but only
 * for GET routes: a status-based refusal when firm B's member asks under firm
 * A's id (A02), and a content-based non-disclosure when they ask under their
 * OWN firm id for firm A's record (A03). A read that leaks is bad; a WRITE
 * that leaks is worse, because direction B degrading to "matched nothing" is
 * not the only acceptable failure mode for a mutation - the row must be
 * PROVABLY untouched, not just absent from the response body.
 *
 * TWO DIRECTIONS, carried over from tenancy.test.ts:
 *
 *   Direction A: firm B's member sends the write under FIRM A's id.
 *     The membership gate answers first: a hard 403, no mutation. Every
 *     write family is one row of the DIRECTION_A table below.
 *
 *   Direction B: firm B's member sends the write under their OWN firm id,
 *     naming firm A's record id.
 *     No membership gate fires here, and the answer is a 404. The repository's
 *     own `law_firm_id` predicate is the only thing standing between the
 *     request and the row,
 *     so the assertion is on the ROW AFTER THE REQUEST, not on the response
 *     status alone - a route that quietly no-ops and still answers 200 must
 *     be caught by DB state, not missed because 200 looked like success.
 *
 * Five route families audited here had never been given this specific check
 * before, confirmed by grep across the whole suite: the client root
 * (update/delete), client events (update/delete), notifications (delete),
 * leads (update/delete), and task subtasks (update/delete) - the last of
 * which only had SAME-firm sibling-parent coverage (A05, in
 * `foreignParentScoping.test.ts`), never a genuinely different firm.
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

/** Firm A owns every resource under test; firm B's owner attempts the writes. */
let firmA: Firm;
let ownerA: Actor;
let firmB: Firm;
let ownerB: Actor;

beforeEach(async () => {
  firmA = await createFirm({ name: 'Firm A' });
  ownerA = await ownerOf(firmA.id);
  firmB = await createFirm({ name: 'Firm B' });
  ownerB = await ownerOf(firmB.id);
  await drainEvents();
});

async function seedEvent(firmId: string, clientId: string, title: string) {
  const res = await ownerA.api
    .post(`/api/lawfirms/${firmId}/clients/${clientId}/events`)
    .send({ type: 'meeting', title, date: '2026-03-10' });
  expect(res.status).toBe(201);
  return res.body.eventId as string;
}

async function notify(lawFirmId: string, userId: string, title: string) {
  const { rows } = await testPool.query(
    `insert into notifications (law_firm_id, user_id, type, title, body, read)
     values ($1, $2, 'task_assigned', $3, 'Body text', false)
     returning id`,
    [lawFirmId, userId, title],
  );
  return rows[0].id as string;
}

async function createLead(lawFirmId: string, caller: Actor, name: string) {
  const res = await caller.api.post(`/api/lawfirms/${lawFirmId}/leads`).send({ name });
  expect(res.status).toBe(201);
  return res.body.lead.id as string;
}

async function seedTaskWithSubtask(lawFirmId: string, caller: Actor) {
  const task = await caller.api.post(`/api/lawfirms/${lawFirmId}/tasks`).send({ title: 'Parent Task' });
  expect(task.status).toBe(201);
  const taskId = task.body.taskId as string;

  const subtask = await caller.api
    .post(`/api/lawfirms/${lawFirmId}/tasks/${taskId}/subtasks`)
    .send({ title: 'Confidential Subtask' });
  expect(subtask.status).toBe(201);
  const subtaskId = subtask.body.subtask.id as string;

  return { taskId, subtaskId };
}

const title = async (table: string, id: string) =>
  (await testPool.query(`select title from ${table} where id = $1`, [id])).rows[0]?.title;
const exists = async (table: string, id: string) =>
  (await testPool.query(`select 1 from ${table} where id = $1`, [id])).rows.length === 1;

/**
 * Direction A, one row per write: firm A's record, reached by firm B's owner
 * through FIRM A's URL. The membership gate answers first, so each is a hard
 * refusal, and each reads the row back afterwards to prove nothing moved.
 */
const DIRECTION_A: Array<{
  name: string;
  attempt: () => Promise<{ status: number; untouched: () => Promise<void> }>;
}> = [
  {
    name: 'updating a client',
    attempt: async () => {
      const client = await createPersonClient(firmA.id, { name: 'Original Name' });
      const res = await ownerB.api.put(`/api/lawfirms/${firmA.id}/clients/${client.id}`).send({ name: 'Hijacked' });
      return {
        status: res.status,
        untouched: async () => {
          const { rows } = await testPool.query('select name from clients where id = $1', [client.id]);
          expect(rows[0].name).toBe('Original Name');
        },
      };
    },
  },
  {
    name: 'deleting a client',
    attempt: async () => {
      const client = await createPersonClient(firmA.id, { name: 'Deletable' });
      const res = await ownerB.api.delete(`/api/lawfirms/${firmA.id}/clients/${client.id}`);
      return { status: res.status, untouched: async () => expect(await exists('clients', client.id)).toBe(true) };
    },
  },
  {
    name: 'updating a client event',
    attempt: async () => {
      const clientA = await createPersonClient(firmA.id, { name: 'A Client' });
      const eventId = await seedEvent(firmA.id, clientA.id, 'Confidential Meeting');
      const res = await ownerB.api
        .put(`/api/lawfirms/${firmA.id}/clients/${clientA.id}/events/${eventId}`)
        .send({ source: 'client', title: 'Hijacked' });
      return {
        status: res.status,
        untouched: async () => expect(await title('events', eventId)).toBe('Confidential Meeting'),
      };
    },
  },
  {
    name: "deleting firm A's own notification",
    attempt: async () => {
      const notificationId = await notify(firmA.id, ownerA.uid, 'Confidential');
      const res = await ownerB.api.delete(`/api/lawfirms/${firmA.id}/notifications/${notificationId}`);
      return { status: res.status, untouched: async () => expect(await exists('notifications', notificationId)).toBe(true) };
    },
  },
  {
    name: 'updating a lead',
    attempt: async () => {
      const leadId = await createLead(firmA.id, ownerA, 'Confidential Prospect');
      const res = await ownerB.api.put(`/api/lawfirms/${firmA.id}/leads/${leadId}`).send({ name: 'Hijacked' });
      return {
        status: res.status,
        untouched: async () => {
          const { rows } = await testPool.query('select name from leads where id = $1', [leadId]);
          expect(rows[0].name).toBe('Confidential Prospect');
        },
      };
    },
  },
  {
    name: 'deleting a lead',
    attempt: async () => {
      const leadId = await createLead(firmA.id, ownerA, 'Deletable');
      const res = await ownerB.api.delete(`/api/lawfirms/${firmA.id}/leads/${leadId}`);
      return { status: res.status, untouched: async () => expect(await exists('leads', leadId)).toBe(true) };
    },
  },
  {
    name: 'updating a task subtask',
    attempt: async () => {
      const { taskId, subtaskId } = await seedTaskWithSubtask(firmA.id, ownerA);
      const res = await ownerB.api
        .put(`/api/lawfirms/${firmA.id}/tasks/${taskId}/subtasks/${subtaskId}`)
        .send({ title: 'Hijacked' });
      return {
        status: res.status,
        untouched: async () => expect(await title('task_subtasks', subtaskId)).toBe('Confidential Subtask'),
      };
    },
  },
  {
    name: 'deleting a task subtask',
    attempt: async () => {
      const { taskId, subtaskId } = await seedTaskWithSubtask(firmA.id, ownerA);
      const res = await ownerB.api.delete(`/api/lawfirms/${firmA.id}/tasks/${taskId}/subtasks/${subtaskId}`);
      return { status: res.status, untouched: async () => expect(await exists('task_subtasks', subtaskId)).toBe(true) };
    },
  },
];

describe('direction A: every write under firm A URL, as a firm B caller', () => {
  it.each(DIRECTION_A)('refuses $name and leaves the row as it was', async ({ attempt }) => {
    const { status, untouched } = await attempt();

    expect(status).toBe(403);
    await untouched();
  });
});

describe('clients: update and delete', () => {
  it('direction B: does not rename firm A client when asked under firm B own URL', async () => {
    const client = await createPersonClient(firmA.id, { name: 'Original Name' });

    const res = await ownerB.api
      .put(`/api/lawfirms/${firmB.id}/clients/${client.id}`)
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select name from clients where id = $1', [client.id]);
    expect(rows[0].name).toBe('Original Name');
  });

  it('direction B: does not delete firm A client when asked under firm B own URL', async () => {
    const client = await createPersonClient(firmA.id, { name: 'Deletable' });

    const res = await ownerB.api.delete(`/api/lawfirms/${firmB.id}/clients/${client.id}`);

    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select id from clients where id = $1', [client.id]);
    expect(rows).toHaveLength(1);
  });

  it('the genuine positive control: firm A can still rename and delete its own client', async () => {
    const client = await createPersonClient(firmA.id, { name: 'Original Name' });

    const renamed = await ownerA.api
      .put(`/api/lawfirms/${firmA.id}/clients/${client.id}`)
      .send({ name: 'Renamed' });
    expect(renamed.status).toBe(200);

    const removed = await ownerA.api.delete(`/api/lawfirms/${firmA.id}/clients/${client.id}`);
    expect(removed.status).toBe(200);
  });
});

describe('client events: update and delete', () => {

  it('direction B: does not update firm A client event when asked under firm B own URL', async () => {
    const clientA = await createPersonClient(firmA.id, { name: 'A Client' });
    const eventId = await seedEvent(firmA.id, clientA.id, 'Confidential Meeting');

    // Firm A's OWN client id and event id, only the firm-id segment swapped
    // to firm B - the pattern `tenancy.test.ts` uses for direction B, so the
    // only thing that can refuse this is the route's own `law_firm_id`
    // predicate, not an incidental client/event id mismatch.
    const res = await ownerB.api
      .put(`/api/lawfirms/${firmB.id}/clients/${clientA.id}/events/${eventId}`)
      .send({ source: 'client', title: 'Hijacked' });

    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select title from events where id = $1', [eventId]);
    expect(rows[0].title).toBe('Confidential Meeting');
  });

  it('direction B: does not delete firm A client event when asked under firm B own URL', async () => {
    const clientA = await createPersonClient(firmA.id, { name: 'A Client' });
    const eventId = await seedEvent(firmA.id, clientA.id, 'Confidential Meeting');

    const res = await ownerB.api
      .delete(`/api/lawfirms/${firmB.id}/clients/${clientA.id}/events/${eventId}`);

    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select id from events where id = $1', [eventId]);
    expect(rows).toHaveLength(1);
  });

  it('IDOR variant: firm B own real client does not unlock firm A event by id alone', async () => {
    const clientA = await createPersonClient(firmA.id, { name: 'A Client' });
    const eventId = await seedEvent(firmA.id, clientA.id, 'Confidential Meeting');
    const clientB = await createPersonClient(firmB.id, { name: 'B Client' });
    await drainEvents();

    // A caller who knows only the event id, and substitutes their OWN client
    // id (a real, same-firm one) rather than the victim's - the clientId and
    // law_firm_id predicates are each independently sufficient to refuse this,
    // which is the defense-in-depth `foreignParentScoping.test.ts` documents.
    const res = await ownerB.api
      .put(`/api/lawfirms/${firmB.id}/clients/${clientB.id}/events/${eventId}`)
      .send({ source: 'client', title: 'Hijacked' });

    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select title from events where id = $1', [eventId]);
    expect(rows[0].title).toBe('Confidential Meeting');
  });

  it('the genuine positive control: firm A can still update and delete its own client event', async () => {
    const clientA = await createPersonClient(firmA.id, { name: 'A Client' });
    const eventId = await seedEvent(firmA.id, clientA.id, 'Original Meeting');

    const updated = await ownerA.api
      .put(`/api/lawfirms/${firmA.id}/clients/${clientA.id}/events/${eventId}`)
      .send({ source: 'client', title: 'Renamed Meeting' });
    expect(updated.status).toBe(200);

    const removed = await ownerA.api
      .delete(`/api/lawfirms/${firmA.id}/clients/${clientA.id}/events/${eventId}`);
    expect(removed.status).toBe(200);
  });
});

describe('notifications: delete', () => {

  it('direction B: leaves firm A notification standing when firm B deletes under its own URL', async () => {
    const notificationId = await notify(firmA.id, ownerA.uid, 'Confidential');

    // Scoped by (law_firm_id, user_id, id) together, so the delete matches
    // nothing: neither the firm nor the recipient line up. `remove()` never
    // checks the affected row count, so this is a case where the ROW is the
    // only thing that can catch a lost scope - the route answers 200 either way.
    const res = await ownerB.api.delete(`/api/lawfirms/${firmB.id}/notifications/${notificationId}`);

    expect(res.status).toBe(200);
    const { rows } = await testPool.query('select id from notifications where id = $1', [notificationId]);
    expect(rows).toHaveLength(1);
  });

  it('the genuine positive control: firm A owner can delete their own notification', async () => {
    const notificationId = await notify(firmA.id, ownerA.uid, 'Ordinary');

    const res = await ownerA.api.delete(`/api/lawfirms/${firmA.id}/notifications/${notificationId}`);

    expect(res.status).toBe(200);
    const { rows } = await testPool.query('select id from notifications where id = $1', [notificationId]);
    expect(rows).toHaveLength(0);
  });
});

describe('leads: update and delete', () => {

  it('direction B: does not rename firm A lead when asked under firm B own URL', async () => {
    const leadId = await createLead(firmA.id, ownerA, 'Confidential Prospect');

    const res = await ownerB.api
      .put(`/api/lawfirms/${firmB.id}/leads/${leadId}`)
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select name from leads where id = $1', [leadId]);
    expect(rows[0].name).toBe('Confidential Prospect');
  });

  it('direction B: does not delete firm A lead when asked under firm B own URL', async () => {
    const leadId = await createLead(firmA.id, ownerA, 'Deletable');

    const res = await ownerB.api.delete(`/api/lawfirms/${firmB.id}/leads/${leadId}`);

    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select id from leads where id = $1', [leadId]);
    expect(rows).toHaveLength(1);
  });

  it('the genuine positive control: firm A can still rename and delete its own lead', async () => {
    const leadId = await createLead(firmA.id, ownerA, 'Original Name');

    const renamed = await ownerA.api
      .put(`/api/lawfirms/${firmA.id}/leads/${leadId}`)
      .send({ name: 'Renamed' });
    expect(renamed.status).toBe(200);

    const removed = await ownerA.api.delete(`/api/lawfirms/${firmA.id}/leads/${leadId}`);
    expect(removed.status).toBe(200);
  });
});

describe('task subtasks: update and delete across a genuinely different firm', () => {

  it('direction B: does not update firm A subtask when asked under firm B own URL', async () => {
    const { taskId, subtaskId } = await seedTaskWithSubtask(firmA.id, ownerA);

    // Firm A's OWN task id and subtask id, only the firm-id segment swapped
    // to firm B - the `tenancy.test.ts` direction-B pattern, isolating
    // `getParentScope`'s own `law_firm_id` filter as the only thing standing
    // between this request and the row.
    const res = await ownerB.api
      .put(`/api/lawfirms/${firmB.id}/tasks/${taskId}/subtasks/${subtaskId}`)
      .send({ title: 'Hijacked' });

    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select title from task_subtasks where id = $1', [subtaskId]);
    expect(rows[0].title).toBe('Confidential Subtask');
  });

  it('IDOR variant: firm B own real task does not unlock firm A subtask by id alone', async () => {
    const { subtaskId } = await seedTaskWithSubtask(firmA.id, ownerA);
    const taskB = await ownerB.api.post(`/api/lawfirms/${firmB.id}/tasks`).send({ title: 'B Task' });
    expect(taskB.status).toBe(201);

    // Firm B's own real task id, but firm A's subtask id. `getParentScope`
    // resolves the task by (lawFirmId, taskId) first; firm B's task exists,
    // so the request reaches `getById`, whose own three-column WHERE
    // (lawFirmId, taskId, subtaskId) is what has to hold the line here - each
    // predicate independently sufficient, the same defense-in-depth
    // `foreignParentScoping.test.ts` documents for the same-firm case.
    const res = await ownerB.api
      .put(`/api/lawfirms/${firmB.id}/tasks/${taskB.body.taskId}/subtasks/${subtaskId}`)
      .send({ title: 'Hijacked' });

    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select title from task_subtasks where id = $1', [subtaskId]);
    expect(rows[0].title).toBe('Confidential Subtask');
  });

  it('direction B: does not delete firm A subtask when asked under firm B own URL', async () => {
    const { taskId, subtaskId } = await seedTaskWithSubtask(firmA.id, ownerA);

    const res = await ownerB.api
      .delete(`/api/lawfirms/${firmB.id}/tasks/${taskId}/subtasks/${subtaskId}`);

    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select id from task_subtasks where id = $1', [subtaskId]);
    expect(rows).toHaveLength(1);
  });

  it('a wholly nonexistent firm B task id also refuses cleanly, not a 500 (no uuid cast error)', async () => {
    const { subtaskId } = await seedTaskWithSubtask(firmA.id, ownerA);

    const res = await ownerB.api
      .put(`/api/lawfirms/${firmB.id}/tasks/${randomUUID()}/subtasks/${subtaskId}`)
      .send({ title: 'Should not land anywhere' });

    expect(res.status).toBe(404);
  });

  it('the genuine positive control: firm A can still update and delete its own subtask', async () => {
    const { taskId, subtaskId } = await seedTaskWithSubtask(firmA.id, ownerA);

    const updated = await ownerA.api
      .put(`/api/lawfirms/${firmA.id}/tasks/${taskId}/subtasks/${subtaskId}`)
      .send({ title: 'Renamed through the real firm' });
    expect(updated.status).toBe(200);

    const removed = await ownerA.api
      .delete(`/api/lawfirms/${firmA.id}/tasks/${taskId}/subtasks/${subtaskId}`);
    expect(removed.status).toBe(200);
  });
});
