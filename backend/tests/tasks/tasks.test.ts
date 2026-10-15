/**
 * Tasks, the firm's work list.
 *
 * Fifteen routes and no tests before this file. A task carries a deadline and an
 * assignee, so the failures that matter here are the ones that make work
 * disappear quietly: a task on the wrong matter, a task nobody is assigned to, a
 * bulk operation that reports success without doing anything.
 *
 * The task/matter pairing gets particular attention. `tasks.matter_id` is what
 * puts a deadline in front of the person running that matter, and a task
 * attached to the wrong one, or to another firm's, is invisible to everyone who
 * needed to see it.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects } from '../support/inMemoryBucket';
const eventBus = require('../../src/shared/events/eventBus');
const { TASK_DELETED } = require('../../src/shared/events/eventTypes');

// Delete and bulk-delete tests deliver the real task file-cleanup listener.
// Install the established bucket double before the app is required, then clear
// it per fixture so that listener remains exercised without fail-loud GCS noise.
installInMemoryBucket();

let firm: Firm;
let owner: Actor;
let matterId: string;

const T = () => `/api/lawfirms/${firm.id}/tasks`;

async function createTask(title: string, extra: Record<string, unknown> = {}) {
  return owner.api.post(T()).send({ title, matterId, ...extra });
}

const idOf = (res: any) => res.body.taskId as string;

const taskRow = async (id: string) => {
  const { rows } = await testPool.query(
    'select title, status, matter_id, law_firm_id from tasks where id = $1', [id],
  );
  return rows[0];
};

const taskCount = async () => {
  const { rows } = await testPool.query(
    'select count(*)::int n from tasks where law_firm_id = $1', [firm.id],
  );
  return rows[0].n;
};

beforeEach(async () => {
  objects.clear();
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: 'Pat Person' });
  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Host Matter',
    clients: [{ clientId: client.id, name: 'Pat Person' }],
  });
  // Assert the fixture SUCCEEDED before reading what it produced. Without this,
  // a create that fails for any reason surfaces as a TypeError on `undefined`
  // several lines later, and the failure names the destructure instead of the
  // request. That has cost real diagnosis time on this suite.
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;
  await drainEvents();
});

describe('creating a task', () => {
  it('attaches it to the matter it was given', async () => {
    const res = await createTask('Draft the motion');

    // The matter link is what puts the deadline in front of the person running
    // that matter. A task on the wrong matter is invisible to everyone who
    // needed it.
    expect((await taskRow(idOf(res))).matter_id).toBe(matterId);
  });

  it('starts it open', async () => {
    const res = await createTask('Draft the motion');

    // A task created already complete would never appear on anyone's list.
    expect((await taskRow(idOf(res))).status).toBe('open');
  });

  it('refuses a recurrence with more than one thousand occurrences before creating the task', async () => {
    const res = await createTask('Long-running deadline', {
      dueDate: '2026-05-10',
      recurrence: { enabled: true, pattern: 'daily', maxOccurrences: 1001 },
    });

    // A recurrence that exceeds its declared cap can keep generating calendar
    // work indefinitely. Refuse it before the task row and its future schedule exist.
    expect(res.status).toBe(400);
    expect(await taskCount()).toBe(0);
  });

  it('accepts a task with no matter at all', async () => {
    const res = await owner.api.post(T()).send({ title: 'Firm admin task' });

    // Not every task belongs to a matter. Requiring one would make internal
    // work unrecordable.
    expect(res.status).toBe(201);
    expect((await taskRow(idOf(res))).matter_id).toBeNull();
  });

  it('records an assignee', async () => {
    const res = await createTask('Assigned work', { assignedTo: [owner.uid] });

    const { rows } = await testPool.query(
      'select user_id from task_assignees where task_id = $1', [idOf(res)],
    );
    // An unassigned task with a deadline is a deadline nobody owns.
    expect(rows.map((r: any) => r.user_id)).toContain(owner.uid);
  });

  it('records SEVERAL assignees on a task with no matter', async () => {
    const colleague = await createFirmMember(firm.id, { isOwner: false, permissions: [] });

    const res = await owner.api.post(T())
      .send({ title: 'Shared admin work', assignedTo: [owner.uid, colleague.uid] });

    const { rows } = await testPool.query(
      'select user_id from task_assignees where task_id = $1', [idOf(res)],
    );
    // No matter, so no matter-membership rule to satisfy. The matter case is
    // covered separately below, because it has an extra condition.
    expect(rows).toHaveLength(2);
  });

  it('refuses to assign a MATTER task to someone not on that matter', async () => {
    const colleague = await createFirmMember(firm.id, { isOwner: false, permissions: [] });

    const res = await createTask('Matter work', { assignedTo: [colleague.uid] });

    // Matter membership is what grants access to the matter's documents, notes
    // and billing. Assigning work on a matter to someone who cannot open it
    // produces a deadline they can see and nothing they can act on, and the
    // refusal says exactly what to do about it.
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/before assigning them work/i);
    // Asserting the DATA too. A route that refused after creating the task
    // would leave an unassigned orphan behind on every rejected attempt.
    expect(await taskCount()).toBe(0);
  });

  it('refuses when ONE of several assignees is not on the matter', async () => {
    const colleague = await createFirmMember(firm.id, { isOwner: false, permissions: [] });

    const res = await createTask('Matter work', { assignedTo: [owner.uid, colleague.uid] });

    // All-or-nothing. Silently dropping the ineligible assignee and creating the
    // task would leave the firm believing two people were assigned.
    expect(res.status).toBe(403);
    expect(await taskCount()).toBe(0);
  });

  it('refuses a task with no title', async () => {
    const res = await owner.api.post(T()).send({});

    expect(res.status).toBe(400);
  });

  it('refuses a whitespace-only title with a VALIDATION error, not a not-found', async () => {
    const res = await createTask('   ');

    // Two defects in one response. The service threw `NotFoundError('Title is
    // required')`, so the status was 404 and the user-facing message rendered as
    // the nonsense "Title is required not found" (NotFoundError appends " not
    // found" to whatever it is given).
    //
    // `taskSubtasks.service.ts` two directories away already throws
    // `ValidationError` for the same check, so the correct shape was sitting
    // right next to it. AGENTS.md: `error` is user-facing copy, written for the
    // end user.
    expect(res.status).toBe(400);
    expect(res.body.error).not.toContain('not found');
  });

  it('refuses a task on ANOTHER firm matter', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/tasks`)
      .send({ title: 'Cross firm task', matterId });

    // Writing a task carrying this firm's matter id under another firm's
    // law_firm_id would make it invisible to both.
    expect(res.status).toBe(404);
    const { rows } = await testPool.query(
      'select id from tasks where matter_id = $1 and law_firm_id = $2',
      [matterId, otherFirm.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a member without the create permission', async () => {
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.post(T()).send({ title: 'Sneaky task' });

    expect(res.status).toBe(403);
  });
});

describe('reading tasks', () => {
  it('serves one by id', async () => {
    const created = await createTask('Single Task');

    const res = await owner.api.get(`${T()}/${idOf(created)}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Single Task');
  });

  it('lists the tasks on one matter', async () => {
    await createTask('On The Matter');
    await owner.api.post(T()).send({ title: 'Not On The Matter' });

    const res = await owner.api.get(`${T()}/matter/${matterId}`);

    // A matter-scoped list that ignored its scope would show a firm every task
    // it has whenever it opened any matter.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('On The Matter');
    expect(JSON.stringify(res.body)).not.toContain('Not On The Matter');
  });

  it('answers not-found for an id that does not exist', async () => {
    const res = await owner.api.get(`${T()}/00000000-0000-0000-0000-000000000000`);

    expect(res.status).toBe(404);
  });

  it('does NOT list another firm tasks', async () => {
    await createTask('Confidential Task');
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api.get(`/api/lawfirms/${otherFirm.id}/tasks`);

    expect(JSON.stringify(res.body)).not.toContain('Confidential Task');
  });

  it('does NOT serve another firm task by id', async () => {
    const created = await createTask('Confidential Task');
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .get(`/api/lawfirms/${otherFirm.id}/tasks/${idOf(created)}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Confidential Task');
  });

  it('serves the caller own assignments', async () => {
    await createTask('Mine', { assignedTo: [owner.uid] });
    const colleague = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    // No matter, so the colleague needs no matter membership to be assigned
    // and the task really exists for the list to leave out.
    const theirs = await owner.api.post(T()).send({ title: 'Theirs', assignedTo: [colleague.uid] });
    expect(theirs.status).toBe(201);

    const res = await owner.api.get(`${T()}/my-assignments`);

    // A personal list that showed everyone's work is not a personal list, and it
    // is what a member opens first each morning.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Mine');
    expect(JSON.stringify(res.body)).not.toContain('Theirs');
  });
});

describe('updating a task', () => {
  it('completes it', async () => {
    const created = await createTask('Completable');

    const res = await owner.api.put(`${T()}/${idOf(created)}`).send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect((await taskRow(idOf(created))).status).toBe('completed');
  });

  it('refuses clearing the due date of a recurring task, and keeps the date', async () => {
    const created = await createTask('Monthly filing', {
      dueDate: '2026-05-10',
      recurrence: { enabled: true, pattern: 'monthly', interval: 1 },
    });
    expect(created.status).toBe(201);

    const res = await owner.api.put(`${T()}/${idOf(created)}`).send({ dueDate: null });

    // Recurrence advances from the due date. Create refuses a recurring task with
    // no date, but an update that sent only `dueDate: null` skipped the check
    // because `recurrence` was not in the body, leaving a recurring task that can
    // never spawn its next occurrence. Red if the check goes back to body-only.
    expect(res.status).toBe(400);
    const { rows } = await testPool.query('select due_date::text d from tasks where id = $1', [idOf(created)]);
    expect(rows[0].d).toBe('2026-05-10');
  });

  it('still clears the due date of a task that does not recur', async () => {
    const created = await createTask('One-off', { dueDate: '2026-05-10' });

    const res = await owner.api.put(`${T()}/${idOf(created)}`).send({ dueDate: null });

    expect(res.status).toBe(200);
    const { rows } = await testPool.query('select due_date from tasks where id = $1', [idOf(created)]);
    expect(rows[0].due_date).toBeNull();
  });

  it('renames it', async () => {
    const created = await createTask('Original Title');

    await owner.api.put(`${T()}/${idOf(created)}`).send({ title: 'New Title' });

    expect((await taskRow(idOf(created))).title).toBe('New Title');
  });

  it('refuses an unknown status', async () => {
    const created = await createTask('Statused');

    const res = await owner.api.put(`${T()}/${idOf(created)}`).send({ status: 'invented' });

    // Status drives every filter and count. An unrecognised value makes the task
    // vanish from all of them at once.
    expect(res.status).toBe(400);
  });

  it('does not let one firm update another firm task', async () => {
    const created = await createTask('Original Title');
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .put(`/api/lawfirms/${otherFirm.id}/tasks/${idOf(created)}`)
      .send({ title: 'Hijacked' });

    expect(res.status).toBe(404);
    expect((await taskRow(idOf(created))).title).toBe('Original Title');
  });
});

describe('deleting a task', () => {
  it('publishes task deletion only after its row has been removed', async () => {
    const created = await createTask('Deletable');
    expect(created.status).toBe(201);
    const taskId = idOf(created);
    let rowAtEvent: unknown = 'listener did not run';
    const listener = async ({ taskId: deletedId }: { taskId: string }) => {
      if (deletedId === taskId) rowAtEvent = await taskRow(taskId);
    };
    eventBus.on(TASK_DELETED, listener);
    try {
      const res = await owner.api.delete(`${T()}/${taskId}`);
      expect(res.status).toBe(200);
      expect(rowAtEvent).toBeUndefined();
    } finally {
      eventBus.off(TASK_DELETED, listener);
    }
  });

  it('finishes task deletion listeners before acknowledging removal', async () => {
    const created = await createTask('Deletable');
    expect(created.status).toBe(201);
    const taskId = idOf(created);
    let finished = false;
    const listener = async ({ taskId: deletedId }: { taskId: string }) => {
      if (deletedId !== taskId) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
      finished = true;
    };
    eventBus.on(TASK_DELETED, listener);
    try {
      const res = await owner.api.delete(`${T()}/${taskId}`);
      expect(res.status).toBe(200);
      expect(finished).toBe(true);
    } finally {
      eventBus.off(TASK_DELETED, listener);
    }
  });

  it('removes it', async () => {
    const created = await createTask('Deletable');

    const res = await owner.api.delete(`${T()}/${idOf(created)}`);

    expect(res.status).toBe(200);
    expect(await taskCount()).toBe(0);
  });

  it('does not let one firm delete another firm task', async () => {
    const created = await createTask('Deletable');
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .delete(`/api/lawfirms/${otherFirm.id}/tasks/${idOf(created)}`);

    expect(res.status).toBe(404);
    expect(await taskCount()).toBe(1);
  });
});

describe('bulk operations', () => {
  it('completes several at once', async () => {
    const a = idOf(await createTask('A'));
    const b = idOf(await createTask('B'));

    const res = await owner.api.post(`${T()}/bulk-status`)
      .send({ taskIds: [a, b], status: 'completed' });

    expect(res.status).toBe(200);
    expect((await taskRow(a)).status).toBe('completed');
    expect((await taskRow(b)).status).toBe('completed');
  });

  it('deletes several at once', async () => {
    const a = idOf(await createTask('A'));
    const b = idOf(await createTask('B'));

    const res = await owner.api.post(`${T()}/bulk-delete`).send({ taskIds: [a, b] });

    expect(res.status).toBe(200);
    expect(await taskCount()).toBe(0);
  });

  it('leaves tasks it was not asked about alone', async () => {
    const a = idOf(await createTask('A'));
    await createTask('Untouched');

    await owner.api.post(`${T()}/bulk-delete`).send({ taskIds: [a] });

    // A bulk operation that ignored its id list and worked on the whole firm
    // reports exactly the same success message.
    expect(await taskCount()).toBe(1);
  });

  it('moves several tasks to another matter', async () => {
    const client = await createPersonClient(firm.id, { name: 'Second Client' });
    const other = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
      name: 'Destination Matter',
      clients: [{ clientId: client.id, name: 'Second Client' }],
    });
    const destinationId = other.body.matterId;
    const a = idOf(await createTask('A'));

    const res = await owner.api.post(`${T()}/bulk-matter`)
      .send({ taskIds: [a], matterId: destinationId });

    expect(res.status).toBe(200);
    expect((await taskRow(a)).matter_id).toBe(destinationId);
  });

  it('does NOT reach into another firm tasks', async () => {
    const mine = idOf(await createTask('Mine'));
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/tasks/bulk-delete`)
      .send({ taskIds: [mine] });

    // The id list is caller-supplied, so it is the easiest place to pass an id
    // from somewhere else and see what happens.
    expect(await taskRow(mine)).toBeDefined();
  });

  it('refuses a member without the permission', async () => {
    const a = idOf(await createTask('A'));
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.post(`${T()}/bulk-delete`).send({ taskIds: [a] });

    expect(res.status).toBe(403);
    expect(await taskCount()).toBe(1);
  });
});

describe('server-owned fields cannot be widened from the body', () => {
  it('ignores a lawFirmId in the create body and scopes the task to the URL firm', async () => {
    const otherFirm = await createFirm();

    const res = await owner.api.post(T())
      .send({ title: 'Escalation Attempt', lawFirmId: otherFirm.id });

    // The route derives its tenant from the URL, not the payload. A body that
    // can redirect a write to a firm the caller only PASSES BY in the URL
    // would let anyone with `tasks.create` in ONE firm plant a task in any
    // other firm they happen to also belong to (see the AGENTS.md rule:
    // "never let a payload widen authority").
    expect(res.status).toBe(201);
    expect((await taskRow(idOf(res))).law_firm_id).toBe(firm.id);
    const leaked = await testPool.query(
      `select id from tasks where law_firm_id = $1 and title = 'Escalation Attempt'`,
      [otherFirm.id],
    );
    expect(leaked.rows).toHaveLength(0);
  });

  it('ignores a taskId/lawFirmId in the update body and never reaches another firm task', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const victim = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/tasks`)
      .send({ title: 'Victim Task' });
    expect(victim.status).toBe(201);
    const victimId = idOf(victim);
    const mine = await createTask('My Own Task');

    // The URL names the task and firm being edited. A `taskId`/`lawFirmId` in
    // the body that could override them would let a caller with `tasks.update`
    // in ANY firm edit a task belonging to a COMPLETELY UNRELATED firm, simply
    // by naming it in the payload of an update they are otherwise entitled to
    // make on their own task.
    const res = await owner.api.put(`${T()}/${idOf(mine)}`)
      .send({ title: 'Hijacked', taskId: victimId, lawFirmId: otherFirm.id });

    expect(res.status).toBe(200);
    expect((await taskRow(idOf(mine))).title).toBe('Hijacked');
    expect((await taskRow(victimId)).title).toBe('Victim Task');
  });
});

describe('subtasks', () => {
  it('adds one to a task', async () => {
    const created = await createTask('Parent Task');

    const res = await owner.api.post(`${T()}/${idOf(created)}/subtasks`)
      .send({ title: 'Sub step' });

    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      'select title from task_subtasks where task_id = $1', [idOf(created)],
    );
    expect(rows.map((r: any) => r.title)).toEqual(['Sub step']);
  });

  it('refuses a whitespace-only subtask title', async () => {
    const created = await createTask('Parent Task');

    const res = await owner.api.post(`${T()}/${idOf(created)}/subtasks`)
      .send({ title: '   ' });

    // The shape the parent task's own check should have had.
    expect(res.status).toBe(400);
  });

  it('does not let one firm add a subtask to another firm task', async () => {
    const created = await createTask('Parent Task');
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/tasks/${idOf(created)}/subtasks`)
      .send({ title: 'Injected step' });

    expect(res.status).toBe(404);
  });

  it('refuses an impossible calendar date for task dueDate', async () => {
    const res = await owner.api.post(T()).send({
      title: 'Task with impossible date',
      dueDate: '2026-02-30',
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/calendar date/i);
    const { rows } = await testPool.query(
      `select id from tasks where law_firm_id = $1 and title = 'Task with impossible date'`,
      [firm.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a numeric dueDate', async () => {
    // An epoch number bypasses `hasValidCalendarDatePrefix` entirely, because
    // that refine short-circuits on a non-string. It would reach the day-only
    // `due_date` DATE column unvalidated. Only 'YYYY-MM-DD' is a due date.
    const res = await owner.api.post(T()).send({
      title: 'Task with epoch date',
      dueDate: 1717200000000,
    });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      `select id from tasks where law_firm_id = $1 and title = 'Task with epoch date'`,
      [firm.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses bulk delete and bulk status with an empty taskIds array', async () => {
    const emptyDelete = await owner.api.post(`${T()}/bulk-delete`).send({
      taskIds: [],
    });
    expect(emptyDelete.status).toBe(400);

    const emptyStatus = await owner.api.post(`${T()}/bulk-status`).send({
      taskIds: [],
      status: 'completed',
    });
    expect(emptyStatus.status).toBe(400);
  });
});
