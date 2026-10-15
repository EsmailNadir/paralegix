/**
 * The tasks service, tested OFFLINE against a fake transport.
 *
 * `tasks.service.ts` reports 0%. A task is what tells a person that something is
 * theirs and when it is due, so the failures worth catching here are the ones a
 * stubbed service hides entirely: an assignee list that leaves the browser in
 * the wrong shape, a filter dropped so a "my work" view quietly widens, or a
 * bulk operation sent to another operation's endpoint.
 *
 * ID LISTS GET THE MOST ATTENTION. `assignedTo`, `clientIds`,
 * `reminderRecipientIds`, `dependencies`, `taskIds` and `subtaskIds` are all
 * arrays of opaque strings travelling together in flat bodies, which is exactly
 * the shape a swap or an unwrap survives: every value is still a non-empty
 * string, the request still succeeds, and nothing downstream can tell.
 *
 * BULK OPERATIONS GET THE SAME TREATMENT AS THE MATTERS SUITE. `bulk-delete`,
 * `bulk-status` and `bulk-matter` share one signature and differ only by path.
 * Note the spelling: tasks use `bulk-status`/`bulk-matter` where matters use
 * `bulk-update-status`, so a path copied across from the matters service reaches
 * nothing at all.
 */
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import tasksService from '@/services/tasks.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { getUserTimeZone } from '@/lib/utils/timezone';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const TASK_ID = 'task-9';

function postBody(api: ApiMock, index = 0): Record<string, unknown> {
  return api.calls('POST')[index].body as Record<string, unknown>;
}

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  // Several cases read the same endpoint in consecutive tests, which trips the
  // dev-only duplicate-GET warning and buries the real output.
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
});

describe('creating a task', () => {
  it('POSTs to the firm tasks route', async () => {
    api.post('/tasks', { message: 'Created', taskId: 'task-new' });

    await tasksService.createTask({ lawFirmId: LAW_FIRM_ID, title: 'File the motion' });

    const [call] = api.calls('POST');
    expect(call.pathname).toContain(LAW_FIRM_ID);
    expect(call.pathname).toMatch(/\/tasks$/);
  });

  it('does NOT send lawFirmId in the body', async () => {
    api.post('/tasks', { message: 'Created', taskId: 'task-new' });

    await tasksService.createTask({ lawFirmId: LAW_FIRM_ID, title: 'File the motion' });

    // The firm is in the PATH. It is destructured out of the payload
    // deliberately, and leaving it in the body gives the server two sources for
    // the same fact that can disagree.
    const body = postBody(api);
    expect(body.lawFirmId).toBeUndefined();
    expect(body.title).toBe('File the motion');
  });

  it('encodes a firm id that would otherwise escape the route', async () => {
    api.post('/tasks', { message: 'Created', taskId: 'task-new' });

    await tasksService.createTask({ lawFirmId: '../evil-firm', title: 'Escape' });

    // The firm id is interpolated straight into the url. Unencoded, `..` is
    // resolved away by the URL parser and the request leaves the firm-scoped
    // route entirely, which is the one thing multi-tenancy cannot survive.
    const { pathname } = api.calls('POST')[0];
    expect(pathname).toContain('/lawfirms/');
    expect(pathname).not.toContain('/lawfirms/../');
  });

  it('returns the new task id', async () => {
    api.post('/tasks', { message: 'Created', taskId: 'task-new' });

    const result = await tasksService.createTask({ lawFirmId: LAW_FIRM_ID, title: 'File the motion' });

    // The caller navigates to this id. Returning the wrong key leaves it opening
    // `/tasks/undefined` straight after a successful create.
    expect(result.taskId).toBe('task-new');
  });

  it('throws when the server refuses the create', async () => {
    api.post('/tasks', { status: 400, body: { error: 'Title is required' } });

    await expect(tasksService.createTask({ lawFirmId: LAW_FIRM_ID, title: '' }))
      .rejects.toThrow(/title is required/i);
  });
});

describe('the assignee list', () => {
  it('sends the EXACT ids it was given, in order', async () => {
    api.post('/tasks', { message: 'Created', taskId: 'task-new' });

    await tasksService.createTask({
      lawFirmId: LAW_FIRM_ID,
      title: 'Draft the brief',
      assignedTo: ['member-1', 'member-2', 'member-3'],
    });

    // Assignment drives the notification, the reminder and every "my tasks"
    // view. A list that arrives short or reordered assigns work to someone who
    // never sees it, and the create still succeeds.
    expect(postBody(api).assignedTo).toEqual(['member-1', 'member-2', 'member-3']);
  });

  it('keeps a single assignee as an ARRAY', async () => {
    api.post('/tasks', { message: 'Created', taskId: 'task-new' });

    await tasksService.createTask({
      lawFirmId: LAW_FIRM_ID,
      title: 'Draft the brief',
      assignedTo: ['member-1'],
    });

    // One assignee is the most common case by far. A service that unwrapped a
    // one-element array into a bare string would change the request shape for
    // exactly that case, and the server's array schema would reject it.
    const assigned = postBody(api).assignedTo;
    expect(Array.isArray(assigned)).toBe(true);
    expect(assigned).toEqual(['member-1']);
  });

  it('sends an empty assignee list as an empty array', async () => {
    api.post('/tasks', { message: 'Created', taskId: 'task-new' });

    await tasksService.createTask({
      lawFirmId: LAW_FIRM_ID,
      title: 'Unowned work',
      assignedTo: [],
    });

    // "Nobody yet" is a real answer and must reach the server as one. Dropping
    // the key lets the server apply its own default instead.
    expect(postBody(api).assignedTo).toEqual([]);
  });

  it('omits the key entirely when no assignment was expressed', async () => {
    api.post('/tasks', { message: 'Created', taskId: 'task-new' });

    await tasksService.createTask({ lawFirmId: LAW_FIRM_ID, title: 'Unowned work' });

    // The negative half of the case above: an omitted key and an empty array
    // mean different things on an update, so they must not collapse into one.
    expect('assignedTo' in postBody(api)).toBe(false);
  });

  it('keeps the three id lists on a task distinct', async () => {
    api.post('/tasks', { message: 'Created', taskId: 'task-new' });

    await tasksService.createTask({
      lawFirmId: LAW_FIRM_ID,
      title: 'Serve the complaint',
      assignedTo: ['member-1'],
      clientIds: ['client-7'],
      reminderRecipientIds: ['member-2'],
      dependencies: ['task-1'],
    });

    // Four arrays of opaque ids in one flat body. Swapping two of them assigns
    // the task to a client id, or reminds the wrong person, and every value is
    // still a well-formed string so nothing complains.
    const body = postBody(api);
    expect(body.assignedTo).toEqual(['member-1']);
    expect(body.clientIds).toEqual(['client-7']);
    expect(body.reminderRecipientIds).toEqual(['member-2']);
    expect(body.dependencies).toEqual(['task-1']);
  });

  it('clears every assignee with an explicit null on update', async () => {
    api.put(`/tasks/${TASK_ID}`, { message: 'Updated', task: { id: TASK_ID } });

    await tasksService.updateTask({
      lawFirmId: LAW_FIRM_ID,
      taskId: TASK_ID,
      assignedTo: null,
    });

    // `null` means "unassign everyone"; an omitted key means "leave assignment
    // alone". A truthiness guard would drop the null, so unassigning would
    // report success and change nothing.
    const body = api.calls('PUT')[0].body as Record<string, unknown>;
    expect(body.assignedTo).toBeNull();
  });

  it('clears a due date with an explicit null the same way', async () => {
    api.put(`/tasks/${TASK_ID}`, { message: 'Updated', task: { id: TASK_ID } });

    await tasksService.updateTask({
      lawFirmId: LAW_FIRM_ID,
      taskId: TASK_ID,
      dueDate: null,
    });

    // Same distinction on the field that drives deadline reminders: a dropped
    // null leaves a deadline the user believes they removed.
    expect((api.calls('PUT')[0].body as Record<string, unknown>).dueDate).toBeNull();
  });

  it('does NOT send lawFirmId or taskId in an update body', async () => {
    api.put(`/tasks/${TASK_ID}`, { message: 'Updated', task: { id: TASK_ID } });

    await tasksService.updateTask({
      lawFirmId: LAW_FIRM_ID,
      taskId: TASK_ID,
      title: 'Renamed',
    });

    const call = api.calls('PUT')[0];
    expect(call.pathname).toMatch(new RegExp(`/tasks/${TASK_ID}$`));
    expect(call.body).toEqual({ title: 'Renamed' });
  });
});

describe('bulk operations send the EXACT id list', () => {
  it('bulk-deletes only the ids given', async () => {
    api.post('/tasks/bulk-delete', { message: 'ok', requested: 2, deleted: 2, failed: [], errors: {} });

    await tasksService.bulkDelete(LAW_FIRM_ID, ['t1', 't2']);

    // The id list is the whole instruction. A bulk delete that sent the wrong
    // list, or an empty one the server read as "everything", is destructive and
    // reports success either way.
    expect(postBody(api).taskIds).toEqual(['t1', 't2']);
  });

  it('preserves a single-element list', async () => {
    api.post('/tasks/bulk-delete', { message: 'ok' });

    await tasksService.bulkDelete(LAW_FIRM_ID, ['t1']);

    const ids = postBody(api).taskIds;
    expect(Array.isArray(ids)).toBe(true);
    expect(ids).toEqual(['t1']);
  });

  it('sends an EMPTY list as an empty array', async () => {
    api.post('/tasks/bulk-delete', { message: 'ok', requested: 0, deleted: 0, failed: [], errors: {} });

    await tasksService.bulkDelete(LAW_FIRM_ID, []);

    // `undefined` here would let the server apply its own default, and a
    // bulk-delete with no scope is the worst possible default.
    expect(postBody(api).taskIds).toEqual([]);
  });

  it('bulk-updates status with the ids and the status', async () => {
    api.post('/tasks/bulk-status', { message: 'ok' });

    await tasksService.bulkUpdateStatus(LAW_FIRM_ID, ['t1', 't2'], 'completed');

    const body = postBody(api);
    expect(body.taskIds).toEqual(['t1', 't2']);
    expect(body.status).toBe('completed');
  });

  it('bulk-reassigns a matter, and detaches with an explicit null', async () => {
    api.post('/tasks/bulk-matter', { message: 'ok' });

    await tasksService.bulkUpdateMatter(LAW_FIRM_ID, ['t1'], 'matter-3');
    await tasksService.bulkUpdateMatter(LAW_FIRM_ID, ['t1'], null);

    // `null` detaches the tasks from any matter. Dropping it would leave them on
    // the matter the user was removing them from, with a success message.
    expect(postBody(api, 0).matterId).toBe('matter-3');
    expect(postBody(api, 1).matterId).toBeNull();
  });

  it('routes each bulk operation to its OWN endpoint', async () => {
    api.post('/tasks/bulk-delete', { message: 'ok' });
    api.post('/tasks/bulk-status', { message: 'ok' });
    api.post('/tasks/bulk-matter', { message: 'ok' });

    await tasksService.bulkDelete(LAW_FIRM_ID, ['t1']);
    await tasksService.bulkUpdateStatus(LAW_FIRM_ID, ['t1'], 'completed');
    await tasksService.bulkUpdateMatter(LAW_FIRM_ID, ['t1'], 'matter-3');

    // Three sweeping operations behind three near-identical signatures. Sending
    // one to another's endpoint would complete the tasks the user asked to
    // delete, or delete the ones they asked to reassign.
    const paths = api.calls('POST').map((c) => c.pathname);
    expect(paths[0]).toMatch(/\/bulk-delete$/);
    expect(paths[1]).toMatch(/\/bulk-status$/);
    expect(paths[2]).toMatch(/\/bulk-matter$/);
  });

  it('reports the per-id outcome the server returned', async () => {
    api.post('/tasks/bulk-delete', {
      message: 'Partially completed',
      requested: 3,
      deleted: 2,
      failed: ['t3'],
      errors: { 't3': 'Task is locked' },
    });

    const result = await tasksService.bulkDelete(LAW_FIRM_ID, ['t1', 't2', 't3']);

    // A bulk endpoint answers 200 with a partial result: the ids it could not
    // act on come back in `failed`, with a reason each in `errors`. Discarding
    // them tells the user all three were deleted when one was not.
    expect(result.requested).toBe(3);
    expect(result.deleted).toBe(2);
    expect(result.failed).toEqual(['t3']);
    expect(result.errors).toEqual({ 't3': 'Task is locked' });
  });

  it('throws when a bulk operation is refused outright', async () => {
    api.post('/tasks/bulk-delete', { status: 403, body: { error: 'Forbidden' } });

    await expect(tasksService.bulkDelete(LAW_FIRM_ID, ['t1'])).rejects.toBeDefined();
  });
});

describe('select-all resolves the ids behind the filters', () => {
  it('passes each filter through under its own key', async () => {
    api.get('/tasks/ids', { ids: [], truncated: false, limit: 5000 });

    await tasksService.listTaskIds(LAW_FIRM_ID, {
      status: 'active',
      assignee: 'member-1',
      matterId: 'matter-3',
      clientId: 'client-7',
      priority: 'high',
      dueFrom: '2026-01-01',
      dueTo: '2026-01-31',
    });

    // These ids feed straight into a bulk delete. A dropped filter widens the
    // selection to tasks the user never saw, and the bulk call that follows acts
    // on all of them.
    const params = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    expect(params.get('status')).toBe('active');
    expect(params.get('assignee')).toBe('member-1');
    expect(params.get('matterId')).toBe('matter-3');
    expect(params.get('clientId')).toBe('client-7');
    expect(params.get('priority')).toBe('high');
    expect(params.get('dueFrom')).toBe('2026-01-01');
    expect(params.get('dueTo')).toBe('2026-01-31');
  });

  it('omits a filter that was not given', async () => {
    api.get('/tasks/ids', { ids: [] });

    await tasksService.listTaskIds(LAW_FIRM_ID, { status: 'active' });

    const params = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    expect(params.has('assignee')).toBe(false);
    expect(params.has('matterId')).toBe(false);
  });

  it('trims the search term and drops a blank one', async () => {
    api.get('/tasks/ids', { ids: [] });

    await tasksService.listTaskIds(LAW_FIRM_ID, { search: '  motion to dismiss  ' });
    await tasksService.listTaskIds(LAW_FIRM_ID, { search: '   ' });

    // Read back through URLSearchParams rather than decodeURIComponent: a query
    // string encodes a space as `+`, which decodeURIComponent leaves alone, so
    // that assertion would fail on a perfectly correct url.
    const first = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    const second = new URL(api.calls('GET')[1].url, 'http://x').searchParams;
    expect(first.get('search')).toBe('motion to dismiss');
    // A whitespace search matches nothing server-side, so sending it would empty
    // the selection instead of leaving it unfiltered.
    expect(second.has('search')).toBe(false);
  });

  it('carries the truncated flag so a partial selection can say so', async () => {
    api.get('/tasks/ids', { ids: ['t1', 't2'], truncated: true, limit: 2 });

    const result = await tasksService.listTaskIds(LAW_FIRM_ID);

    // "Select all" means every task behind the filters. When the server capped
    // the answer, the flag is the only thing telling the user the bulk action
    // will cover part of it.
    expect(result.ids).toEqual(['t1', 't2']);
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(2);
  });

  it('reports a complete answer as not truncated', async () => {
    api.get('/tasks/ids', { ids: ['t1'] });

    const result = await tasksService.listTaskIds(LAW_FIRM_ID);

    // The negative half, and the empty-list default: a missing `ids` key must not
    // become `undefined` on a value the caller is about to spread into a request.
    expect(result.truncated).toBe(false);
    expect(result.ids).toEqual(['t1']);
  });

  it('defaults a missing envelope to an empty selection', async () => {
    api.get('/tasks/ids', {});

    expect(await tasksService.listTaskIds(LAW_FIRM_ID)).toEqual({
      ids: [], truncated: false, limit: 0,
    });
  });
});

describe('the paged task list', () => {
  const PAGE = { tasks: [], totalTasks: 0 };

  it('always sends the viewer timezone', async () => {
    api.get('/tasks', PAGE);

    await tasksService.listLawFirmTasksPaged(LAW_FIRM_ID);

    // Due dates are day-only values the backend renders in the viewer's zone, so
    // without this an "overdue today" list is computed in the wrong day.
    const params = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    expect(params.get('tz')).toBeTruthy();
  });

  it('passes the window, the filters and the sort model', async () => {
    api.get('/tasks', PAGE);

    await tasksService.listLawFirmTasksPaged(LAW_FIRM_ID, {
      page: 2,
      limit: 25,
      status: 'active',
      assignee: 'member-1',
      matterId: 'matter-3',
      priority: 'urgent',
      search: '  motion to dismiss  ',
      sort: [{ field: 'dueDate', sort: 'asc' }, { field: 'priority', sort: 'desc' }],
    });

    const params = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    expect(params.get('page')).toBe('2');
    expect(params.get('limit')).toBe('25');
    expect(params.get('status')).toBe('active');
    expect(params.get('assignee')).toBe('member-1');
    expect(params.get('priority')).toBe('urgent');
    // Trimmed, and read back through URLSearchParams because the space is
    // encoded as `+` in the query string.
    expect(params.get('search')).toBe('motion to dismiss');
    // The multi-column model is serialised as `field:dir,field:dir`, the exact
    // shape the backend's regex validation accepts.
    expect(params.get('sort')).toBe('dueDate:asc,priority:desc');
  });

  it('omits filters that were not given', async () => {
    api.get('/tasks', PAGE);

    await tasksService.listLawFirmTasksPaged(LAW_FIRM_ID, { status: 'active' });

    // `assignee=undefined` matches no member, so a firm-wide list would render
    // empty and read as "there is no work".
    const params = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    expect(params.has('assignee')).toBe(false);
    expect(params.has('matterId')).toBe(false);
    expect(params.has('search')).toBe(false);
  });

  it('bounds a read by due date without switching off the full result', async () => {
    api.get('/tasks', PAGE);

    await tasksService.listLawFirmTasksPaged(LAW_FIRM_ID, {
      dueFrom: '2026-02-01', dueTo: '2026-02-28',
    });

    // The calendar reads a whole month this way. They are pure filters: sent
    // alone they add no page window, so the caller gets every task in the range
    // rather than the first page of it.
    const params = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    expect(params.get('dueFrom')).toBe('2026-02-01');
    expect(params.get('dueTo')).toBe('2026-02-28');
    expect(params.has('page')).toBe(false);
    expect(params.has('limit')).toBe(false);
  });

  it('keeps the filtered total the server reported', async () => {
    api.get('/tasks', { tasks: [{ id: 't1' }], totalTasks: 143 });

    const page = await tasksService.listLawFirmTasksPaged(LAW_FIRM_ID, { limit: 1 });

    // A total taken from the rendered rows would say 1, and the pager would stop
    // offering the other 142.
    expect(page.tasks).toHaveLength(1);
    expect(page.totalTasks).toBe(143);
  });

  it('falls back to the rendered count when the server omits the total', async () => {
    api.get('/tasks', { tasks: [{ id: 't1' }, { id: 't2' }] });

    const page = await tasksService.listLawFirmTasksPaged(LAW_FIRM_ID);

    // Deliberately not 0: a zero total with two rows on screen makes the pager
    // contradict the list it sits under.
    expect(page.totalTasks).toBe(2);
  });

  it('defaults a missing envelope to an empty page', async () => {
    api.get('/tasks', {});

    const page = await tasksService.listLawFirmTasksPaged(LAW_FIRM_ID);

    expect(page.tasks).toEqual([]);
    expect(page.totalTasks).toBe(0);
  });

  it('returns an empty list rather than undefined from the unpaged read', async () => {
    api.get('/tasks', {});

    // The grid maps over this. `undefined` throws before the page renders, which
    // reads as tasks being broken rather than empty.
    expect(await tasksService.listLawFirmTasks(LAW_FIRM_ID)).toEqual([]);
  });

  it('reads a matter task list from the matter route', async () => {
    api.get('/tasks/matter/matter-3', { tasks: [{ id: 't1' }] });

    const tasks = await tasksService.listMatterTasks(LAW_FIRM_ID, 'matter-3');

    // Its own endpoint rather than the firm list with a filter. Falling back to
    // the firm list would show a matter every task in the firm.
    expect(api.calls('GET')[0].pathname).toMatch(/\/tasks\/matter\/matter-3$/);
    expect(tasks).toHaveLength(1);
  });
});

describe('the task typeahead', () => {
  it('sends ids as ONE comma-joined parameter', async () => {
    api.get('/tasks/lookup', { items: [], hasMore: false });

    await tasksService.lookupTasks(LAW_FIRM_ID, { ids: ['t1', 't2', 't3'] });

    // The server splits on commas. Sending repeated `ids=` keys, or a JSON
    // array, resolves nothing and a form holding saved selections renders them
    // all as blank rows.
    const params = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    expect(params.getAll('ids')).toEqual(['t1,t2,t3']);
  });

  it('sends a search term instead when there are no ids', async () => {
    api.get('/tasks/lookup', { items: [], hasMore: false });

    await tasksService.lookupTasks(LAW_FIRM_ID, { search: 'motion', limit: 20 });

    // `search` and `ids` are mutually exclusive server-side. Sending both would
    // let the id resolution fall back to an arbitrary search page, so a stale id
    // would render as some unrelated task.
    const params = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    expect(params.get('search')).toBe('motion');
    expect(params.has('ids')).toBe(false);
    expect(params.get('limit')).toBe('20');
  });

  it('scopes the lookup to a client when asked', async () => {
    api.get('/tasks/lookup', { items: [], hasMore: false });

    await tasksService.lookupTasks(LAW_FIRM_ID, { search: 'motion', clientId: 'client-7' });

    const params = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    expect(params.get('clientId')).toBe('client-7');
  });

  it('defaults a missing envelope to an empty result', async () => {
    api.get('/tasks/lookup', {});

    expect(await tasksService.lookupTasks(LAW_FIRM_ID)).toEqual({ items: [], hasMore: false });
  });
});

describe('subtasks', () => {
  it('creates one on the task subtask route', async () => {
    api.post(`/tasks/${TASK_ID}/subtasks`, { subtask: { id: 'sub-1', title: 'Pull exhibits' } });

    const created = await tasksService.createSubtask(LAW_FIRM_ID, TASK_ID, {
      title: 'Pull exhibits', assigneeUserId: 'member-1',
    });

    const [call] = api.calls('POST');
    expect(call.pathname).toMatch(new RegExp(`/tasks/${TASK_ID}/subtasks$`));
    expect((call.body as Record<string, unknown>).assigneeUserId).toBe('member-1');
    expect(created.id).toBe('sub-1');
  });

  it('reorders through a DIFFERENT endpoint, sending the new order', async () => {
    api.post(`/tasks/${TASK_ID}/subtasks/reorder`, { subtasks: [] });

    await tasksService.reorderSubtasks(LAW_FIRM_ID, TASK_ID, ['sub-3', 'sub-1', 'sub-2']);

    // The order of the array IS the payload here, not incidental. A reversed or
    // re-sorted list silently rewrites a checklist the user just arranged, and
    // create and reorder differ only by the trailing path segment.
    const [call] = api.calls('POST');
    expect(call.pathname).toMatch(/\/subtasks\/reorder$/);
    expect((call.body as Record<string, unknown>).subtaskIds).toEqual(['sub-3', 'sub-1', 'sub-2']);
  });

  it('returns an empty list rather than undefined', async () => {
    api.get(`/tasks/${TASK_ID}/subtasks`, {});

    expect(await tasksService.listSubtasks(LAW_FIRM_ID, TASK_ID)).toEqual([]);
  });

  it('throws when a subtask update is refused', async () => {
    api.put(`/tasks/${TASK_ID}/subtasks/sub-1`, {
      status: 403, body: { error: 'You cannot edit this checklist' },
    });

    await expect(tasksService.updateSubtask(LAW_FIRM_ID, TASK_ID, 'sub-1', { isCompleted: true }))
      .rejects.toThrow(/cannot edit this checklist/i);
  });
});

describe('reading and deleting one task', () => {
  it('GETs the task by id with the viewer timezone', async () => {
    api.get(`/tasks/${TASK_ID}`, { id: TASK_ID, title: 'File the motion' });

    const task = await tasksService.getTask(LAW_FIRM_ID, TASK_ID);

    expect(task.title).toBe('File the motion');
    const params = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    expect(params.get('tz')).toBeTruthy();
  });

  it('encodes a task id that would otherwise escape the route', async () => {
    api.get('/tasks/..%2F..%2Fother', { id: 'x' });

    await tasksService.getTask(LAW_FIRM_ID, '../../other');

    const { pathname } = api.calls('GET')[0];
    expect(pathname).toContain(`/lawfirms/${LAW_FIRM_ID}/tasks/`);
    expect(pathname).not.toContain('/../');
  });

  it('THROWS on a failed read rather than returning a blank task', async () => {
    api.get(`/tasks/${TASK_ID}`, { status: 404, body: { error: 'Task not found' } });

    // A task page rendered from a swallowed 404 shows empty fields, which reads
    // as a task with no details rather than one that does not exist.
    await expect(tasksService.getTask(LAW_FIRM_ID, TASK_ID)).rejects.toThrow(/not found/i);
  });

  it('DELETEs one task by id', async () => {
    api.delete(`/tasks/${TASK_ID}`, { message: 'Deleted' });

    await tasksService.deleteTask(LAW_FIRM_ID, TASK_ID);

    expect(api.calls('DELETE')[0].pathname).toMatch(new RegExp(`/tasks/${TASK_ID}$`));
  });

  it('throws when a delete is refused', async () => {
    api.delete(`/tasks/${TASK_ID}`, {
      status: 403, body: { error: 'Only the assignee or an admin can delete this task' },
    });

    // The row must not disappear from the screen and return on the next load.
    await expect(tasksService.deleteTask(LAW_FIRM_ID, TASK_ID))
      .rejects.toThrow(/assignee or an admin/i);
  });
});

describe('every task request identifies its caller', () => {
  it('sends the Authorization header on a read', async () => {
    api.get('/tasks', { tasks: [] });

    await tasksService.listLawFirmTasks(LAW_FIRM_ID);

    expect(api.calls('GET')[0].headers.authorization).toMatch(/^Bearer /);
  });

  it('sends the Authorization, JSON and timezone headers on a write', async () => {
    api.post('/tasks', { message: 'Created', taskId: 'task-new' });

    await tasksService.createTask({ lawFirmId: LAW_FIRM_ID, title: 'File the motion' });

    // Without the content type Express parses no body, and the task arrives with
    // no title, no assignees and no due date. The tasks router requires the
    // timezone header.
    const { headers } = api.calls('POST')[0];
    expect(headers.authorization).toMatch(/^Bearer /);
    expect(headers['content-type']).toContain('application/json');
    expect(headers['x-timezone']).toBeTruthy();
  });
});

/**
 * Exact-path cases for the remaining task surface. `getExact`/`deleteExact`
 * match the WHOLE pathname and query, so a request that drifts to another firm
 * or another task matches nothing and the transport throws.
 */
const TASKS = `/api/lawfirms/${LAW_FIRM_ID}/tasks`;
const TASK = `${TASKS}/${TASK_ID}`;

function onlyCall(method: string) {
  const calls = api.calls(method);
  expect(calls).toHaveLength(1);
  return calls[0];
}

async function rejectionOf(promise: Promise<unknown>): Promise<ApiError> {
  return promise.then(
    () => { throw new Error('expected the call to reject'); },
    (error: unknown) => error as ApiError,
  );
}

describe('subtask edits and removal', () => {
  it('PUTs only the changed fields and returns the subtask from its envelope', async () => {
    api.putExact(`${TASK}/subtasks/sub-1`, { subtask: { id: 'sub-1', isCompleted: true } });

    const updated = await tasksService.updateSubtask(LAW_FIRM_ID, TASK_ID, 'sub-1', { isCompleted: true });

    expect(onlyCall('PUT').body).toEqual({ isCompleted: true });
    expect(updated).toEqual({ id: 'sub-1', isCompleted: true });
  });

  it('DELETEs one subtask by id', async () => {
    api.deleteExact(`${TASK}/subtasks/sub-1`, { message: 'Subtask deleted' });

    await expect(tasksService.deleteSubtask(LAW_FIRM_ID, TASK_ID, 'sub-1')).resolves.toEqual({ message: 'Subtask deleted' });
  });

  it('returns the reordered list, empty for a bare envelope', async () => {
    api.postExact(`${TASK}/subtasks/reorder`, {});

    await expect(tasksService.reorderSubtasks(LAW_FIRM_ID, TASK_ID, ['sub-1'])).resolves.toEqual([]);
  });

  it.each([
    ['deleteSubtask', 'delete', `${TASK}/subtasks/sub-1`, () => tasksService.deleteSubtask(LAW_FIRM_ID, TASK_ID, 'sub-1'), 'Failed to delete subtask'],
    ['reorderSubtasks', 'post', `${TASK}/subtasks/reorder`, () => tasksService.reorderSubtasks(LAW_FIRM_ID, TASK_ID, []), 'Failed to reorder subtasks'],
    ['updateSubtask', 'put', `${TASK}/subtasks/sub-1`, () => tasksService.updateSubtask(LAW_FIRM_ID, TASK_ID, 'sub-1', {}), 'Failed to update subtask'],
  ] as const)('%s throws its own message on a bare refusal', async (_name, method, path, run, message) => {
    ({ delete: api.deleteExact, post: api.postExact, put: api.putExact })[method](path, { status: 422, body: {} });

    const error = await rejectionOf(run());
    expect(error.message).toBe(message);
    expect(error.status).toBe(422);
  });
});

describe('task notes delegate to the shared notes routes under this task', () => {
  const NOTE = `${TASK}/notes/note-1`;
  const rows: Array<[string, string, string, () => Promise<unknown>]> = [
    ['listTaskNotes', 'GET', `${TASK}/notes`, () => tasksService.listTaskNotes(LAW_FIRM_ID, TASK_ID)],
    ['getTaskNote', 'GET', NOTE, () => tasksService.getTaskNote(LAW_FIRM_ID, TASK_ID, 'note-1')],
    ['addNoteToTask', 'POST', `${TASK}/notes`, () => tasksService.addNoteToTask(LAW_FIRM_ID, TASK_ID, { content: 'x' } as never)],
    ['updateNoteInTask', 'PUT', NOTE, () => tasksService.updateNoteInTask(LAW_FIRM_ID, TASK_ID, 'note-1', { content: 'y' } as never)],
    ['retractNoteFromTask', 'DELETE', NOTE, () => tasksService.retractNoteFromTask(LAW_FIRM_ID, TASK_ID, 'note-1', 'wrong task')],
    ['addTaskNoteTimeEntry', 'POST', `${NOTE}/time`, () => tasksService.addTaskNoteTimeEntry(LAW_FIRM_ID, TASK_ID, 'note-1', { hours: 1 } as never)],
    ['updateTaskNoteTimeEntry', 'PUT', `${NOTE}/time/te-1`, () => tasksService.updateTaskNoteTimeEntry(LAW_FIRM_ID, TASK_ID, 'note-1', 'te-1', { hours: 2 } as never)],
    ['removeTaskNoteTimeEntry', 'DELETE', `${NOTE}/time/te-1`, () => tasksService.removeTaskNoteTimeEntry(LAW_FIRM_ID, TASK_ID, 'note-1', 'te-1')],
    ['setTaskNotePinned', 'PUT', `${NOTE}/pin`, () => tasksService.setTaskNotePinned(LAW_FIRM_ID, TASK_ID, 'note-1', true)],
    ['listTaskNoteVersions', 'GET', `${NOTE}/versions`, () => tasksService.listTaskNoteVersions(LAW_FIRM_ID, TASK_ID, 'note-1')],
    ['listTaskNoteReplies', 'GET', `${NOTE}/replies`, () => tasksService.listTaskNoteReplies(LAW_FIRM_ID, TASK_ID, 'note-1')],
    ['addTaskNoteReply', 'POST', `${NOTE}/replies`, () => tasksService.addTaskNoteReply(LAW_FIRM_ID, TASK_ID, 'note-1', { content: 'r' } as never)],
    ['updateTaskNoteReply', 'PUT', `${NOTE}/replies/rep-1`, () => tasksService.updateTaskNoteReply(LAW_FIRM_ID, TASK_ID, 'note-1', 'rep-1', { content: 'r2' } as never)],
    ['retractTaskNoteReply', 'DELETE', `${NOTE}/replies/rep-1`, () => tasksService.retractTaskNoteReply(LAW_FIRM_ID, TASK_ID, 'note-1', 'rep-1')],
  ];

  it.each(rows)('%s', async (_name, method, path, run) => {
    // Route only: the shared notes module owns response shaping and has its own
    // specs. What this pins is that the task wrapper reaches the right verb on
    // the right route under the right TASK, not a matter or client.
    const register = { GET: api.get, POST: api.post, PUT: api.put, DELETE: api.delete }[method]!;
    register(path, { status: 422, body: { error: 'stop here' } });

    await expect(run()).rejects.toThrow('stop here');

    expect(onlyCall(method).pathname).toBe(path);
  });
});

describe('task reads that depend on the viewer timezone', () => {
  it('reads the dependency graph with tz in the query', async () => {
    const graph = { blockedBy: [{ id: 'task-1' }], blocking: [] };
    api.getExact(`${TASK}/dependencies?tz=${encodeURIComponent(getUserTimeZone())}`, graph);

    await expect(tasksService.getTaskDependencies(LAW_FIRM_ID, TASK_ID)).resolves.toEqual(graph);
  });

  it('reads my assignments with tz in the query', async () => {
    const mine = { tasks: [{ id: TASK_ID }], totalTasks: 1 };
    api.getExact(`${TASKS}/my-assignments?tz=${encodeURIComponent(getUserTimeZone())}`, mine);

    await expect(tasksService.getMyAssignments(LAW_FIRM_ID)).resolves.toEqual(mine);
  });

  it('reads analytics for the whole history by default', async () => {
    api.getExact(`${TASKS}/analytics?dateRange=all`, { summary: { total: 3 } });

    await expect(tasksService.getTaskAnalytics(LAW_FIRM_ID)).resolves.toEqual({ summary: { total: 3 } });
  });

  it('reads analytics for the range asked', async () => {
    api.getExact(`${TASKS}/analytics?dateRange=30d`, { summary: { total: 1 } });

    await tasksService.getTaskAnalytics(LAW_FIRM_ID, '30d');

    expect(onlyCall('GET').search).toBe('?dateRange=30d');
  });

  it('surfaces a refused analytics read as an ApiError', async () => {
    api.getExact(`${TASKS}/analytics?dateRange=all`, { status: 403, body: { error: 'Forbidden' } });

    const error = await rejectionOf(tasksService.getTaskAnalytics(LAW_FIRM_ID));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(403);
  });
});
