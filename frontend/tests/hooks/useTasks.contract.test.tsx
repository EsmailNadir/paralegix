/**
 * Offline contracts for the firm task list.
 *
 * The existing `useTasks.test.ts` drives a live backend and is excluded from
 * `npm run test:unit`, so nothing in ordinary CI covered this hook. That matters
 * more than it sounds: the hook builds a paged request whose parameter names
 * differ from its own option names (`assignedTo` becomes `assignee`), and a
 * dropped or renamed parameter is invisible on screen. The list simply comes
 * back unfiltered, which looks like data rather than like a bug.
 *
 * Driven through the real `tasks.service` against the transport fake, so url
 * building, query assembly, header attachment and response unwrapping all run.
 */
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/requestDeduplicator');

import { act, renderHook, waitFor } from '@testing-library/react';

import {
  useBulkTasks,
  useCreateTask,
  useEditTask,
  useLawfirmTasks,
  useTaskById,
} from '@/hooks/taskHooks/useTasks';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { getUserTimeZone } from '@/lib/utils/timezone';
import type { Task } from '@/types';

import { sequence, setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated, itSendsNothingWithoutScope } from '../support/scopeIsolation';

// Read from the helper the service itself uses. Hard-coding a zone would pin the
// machine the suite runs on, not the contract: CI is UTC and a laptop is not.
const TZ = encodeURIComponent(getUserTimeZone());
const TASKS_A = `/api/lawfirms/firm-a/tasks?tz=${TZ}`;

const api = setupApiMock();

// A mutation's invalidation refetches the list it just loaded, which trips the
// dev-only duplicate-GET warning. That second GET is the behaviour under test
// here, so the warning would only bury real output.
beforeEach(() => {
  process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off';
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN;
});

describe('the hook does not request a list it has no scope for', () => {
  it('sends nothing before a firm id exists', async () => {
    const { result } = renderHook(() => useLawfirmTasks(undefined), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tasks).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(api.calls()).toEqual([]);
  });

  it('sends nothing while the caller has the query gated off', async () => {
    // The gate exists so a view loads tasks only while it is on screen (the
    // files page holds its tasks tab back until that tab is open). A hook that
    // fetched anyway would pull tasks on every page that mounts it.
    const { result } = renderHook(
      () => useLawfirmTasks('firm-a', { enabled: false, page: 1, limit: 25 }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.calls()).toEqual([]);
  });
});

describe('the unpaged list', () => {
  it('requests the firm scope with the viewer timezone and reports its own total', async () => {
    api.getExact(TASKS_A, { tasks: [{ taskId: 't1' }, { taskId: 't2' }] });

    const { result } = renderHook(() => useLawfirmTasks('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.tasks).toHaveLength(2));
    // With no server total to read, the count is the list length. A hook that
    // reported 0 here would collapse a pagination footer that has rows above it.
    expect(result.current.total).toBe(2);
    expect(result.current.error).toBeNull();
    expect(api.calls()[0].query.tz).toEqual([getUserTimeZone()]);
  });

  it('treats a whitespace-only search as no search at all', async () => {
    // The hook decides between the paged and unpaged endpoints on whether any
    // filter is set, and a blank search must not flip it. Sending `search=` to
    // the paged route instead would key a separate cache entry and refetch the
    // same rows under a different url.
    api.getExact(TASKS_A, { tasks: [{ taskId: 'unpaged' }] });

    const { result } = renderHook(
      () => useLawfirmTasks('firm-a', { search: '   ' }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    expect(api.calls()).toHaveLength(1);
    expect(api.calls()[0].query.search).toBeUndefined();
  });
});

describe('the paged list sends every filter it was given', () => {
  it('renames assignedTo to the assignee parameter the API reads', async () => {
    // The one rename in the contract. A hook that passed `assignedTo` through
    // would have the server ignore it and answer the whole firm's tasks, which
    // reads as "this person is on everything" rather than as a broken filter.
    api.getExact(
      `${TASKS_A}&page=2&limit=25&status=active&assignee=user-7&matterId=matter-3&priority=high&dueFrom=2026-01-01&dueTo=2026-01-31&search=deposition&sortBy=dueDate&order=asc`,
      { tasks: [{ taskId: 'filtered' }], totalTasks: 41 },
    );

    const { result } = renderHook(
      () => useLawfirmTasks('firm-a', {
        page: 2,
        limit: 25,
        status: 'active',
        assignedTo: 'user-7',
        matterId: 'matter-3',
        priority: 'high',
        dueFrom: '2026-01-01',
        dueTo: '2026-01-31',
        search: 'deposition',
        sortBy: 'dueDate',
        order: 'asc',
      }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    expect(result.current.total).toBe(41);

    const [call] = api.calls();
    expect(call.query.assignee).toEqual(['user-7']);
    expect(call.query.assignedTo).toBeUndefined();
  });

  it('trims the search before sending it', async () => {
    api.getExact(`${TASKS_A}&limit=10&search=motion`, { tasks: [], totalTasks: 0 });

    const { result } = renderHook(
      () => useLawfirmTasks('firm-a', { limit: 10, search: '  motion  ' }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.calls()[0].query.search).toEqual(['motion']);
  });

  it('encodes a multi-column sort as the shape the backend validates', async () => {
    // `field:dir,field:dir`. The backend checks it with a regex, so a different
    // encoding is a 400 rather than an ignored parameter.
    api.getExact(`${TASKS_A}&limit=10&sort=priority%3Adesc%2CdueDate%3Aasc`, { tasks: [], totalTasks: 0 });

    const { result } = renderHook(
      () => useLawfirmTasks('firm-a', {
        limit: 10,
        sort: [{ field: 'priority', sort: 'desc' }, { field: 'dueDate', sort: 'asc' }],
      }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.calls()[0].query.sort).toEqual(['priority:desc,dueDate:asc']);
  });
});

describe('paging and failure states', () => {
  it('keeps the previous page and its total on screen while the next one loads', async () => {
    // Without this the footer drops to `total: 0` mid-transition and collapses
    // back to page 1, which moves the control the user is clicking.
    api.getExact(`${TASKS_A}&page=1&limit=10`, { tasks: [{ taskId: 'page-one' }], totalTasks: 30 });
    api.getExact(`${TASKS_A}&page=2&limit=10`, { status: 200, body: { tasks: [{ taskId: 'page-two' }], totalTasks: 30 }, delayMs: 40 });

    const { result, rerender } = renderHook(
      ({ page }: { page: number }) => useLawfirmTasks('firm-a', { page, limit: 10 }),
      { wrapper: createQueryWrapper(), initialProps: { page: 1 } },
    );

    await waitFor(() => expect(result.current.tasks.map((t) => t.taskId)).toEqual(['page-one']));

    rerender({ page: 2 });

    // Mid-flight: the old rows and the real total are still there.
    expect(result.current.tasks.map((t) => t.taskId)).toEqual(['page-one']);
    expect(result.current.total).toBe(30);

    await waitFor(() => expect(result.current.tasks.map((t) => t.taskId)).toEqual(['page-two']));
    expect(result.current.total).toBe(30);
  });

  it('reports a failed load instead of presenting zero tasks as success', async () => {
    // An empty list and a failed request look identical on screen. If the hook
    // swallowed this, a firm whose tasks failed to load would be told it has
    // none, and the obvious next action is to create duplicates.
    api.getExact(TASKS_A, { status: 500, body: { error: 'Task service unavailable' } });

    const { result } = renderHook(() => useLawfirmTasks('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.error).toMatch(/Task service unavailable/i));
    expect(result.current.tasks).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it('reports a 503 without the maintenance code as an outage, not as maintenance', async () => {
    // Not the same as the case above, and the difference is deliberate: a 503
    // with no code is the platform shedding load, not a fact about tasks, so the
    // body is not shown. Only the backend's MAINTENANCE_MODE answer may claim a
    // maintenance window; a busy instance is not one.
    api.getExact(TASKS_A, { status: 503, body: { error: 'Task service unavailable' } });

    const { result } = renderHook(() => useLawfirmTasks('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.error).toMatch(/something went wrong on our end/i));
    expect(result.current.error).not.toMatch(/maintenance/i);
    expect(result.current.error).not.toMatch(/Task service unavailable/i);
    expect(result.current.tasks).toEqual([]);
  });

  it('does not show one firm the rows of another after a scope change', async () => {
    api.getExact(TASKS_A, { tasks: [{ taskId: 'firm-a-task' }] });
    api.getExact(`/api/lawfirms/firm-b/tasks?tz=${TZ}`, { tasks: [{ taskId: 'firm-b-task' }] });

    const { result, rerender } = renderHook(
      ({ firm }: { firm: string }) => useLawfirmTasks(firm),
      { wrapper: createQueryWrapper(), initialProps: { firm: 'firm-a' } },
    );

    await waitFor(() => expect(result.current.tasks.map((t) => t.taskId)).toEqual(['firm-a-task']));

    rerender({ firm: 'firm-b' });

    await waitFor(() => expect(result.current.tasks.map((t) => t.taskId)).toEqual(['firm-b-task']));
    // The cache is keyed by firm, so the previous firm's rows must not survive
    // the switch even for a frame. This is the leak the whole tenancy rule
    // exists to prevent, on the client side.
    expect(result.current.tasks.map((t) => t.taskId)).not.toContain('firm-a-task');
  });
});

const TASKS_B = `/api/lawfirms/firm-b/tasks?tz=${TZ}`;
const taskIds = (r: { tasks: Task[] }) => r.tasks.map((t) => t.taskId ?? '');

describe('switching firms never shows the previous firm its tasks', () => {
  // The list keeps the previous result on screen while the next one loads, and
  // only a guard on the previous key's FIRM stops that handing one firm's
  // tasks to another. Breaking the guard (or reverting to bare
  // `keepPreviousData`) turns these red.
  itKeepsScopeIsolated({
    title: 'unpaged: firm A rows are gone while firm B is still loading',
    mode: 'pending',
    api: () => api,
    useHook: ({ firm }: { firm: string }) => useLawfirmTasks(firm),
    ids: taskIds,
    a: { props: { firm: 'firm-a' }, url: TASKS_A, body: { tasks: [{ taskId: 'firm-a-task' }] }, ids: ['firm-a-task'] },
    b: { props: { firm: 'firm-b' }, url: TASKS_B, body: { tasks: [{ taskId: 'firm-b-task' }] }, ids: ['firm-b-task'] },
  });

  itKeepsScopeIsolated({
    title: 'paged: the same page window in another firm does not inherit the old rows or total',
    mode: 'pending',
    api: () => api,
    useHook: ({ firm }: { firm: string }) => useLawfirmTasks(firm, { page: 1, limit: 10 }),
    ids: taskIds,
    a: {
      props: { firm: 'firm-a' },
      url: `${TASKS_A}&page=1&limit=10`,
      body: { tasks: [{ taskId: 'firm-a-paged' }], totalTasks: 40 },
      ids: ['firm-a-paged'],
    },
    b: {
      props: { firm: 'firm-b' },
      url: `${TASKS_B}&page=1&limit=10`,
      body: { tasks: [{ taskId: 'firm-b-paged' }], totalTasks: 3 },
      ids: ['firm-b-paged'],
    },
    finally: (r) => expect(r.total).toBe(3),
  });

  itKeepsScopeIsolated({
    title: 'paged: a late answer for the old firm does not overwrite the new firm',
    mode: 'late',
    api: () => api,
    useHook: ({ firm }: { firm: string }) => useLawfirmTasks(firm, { page: 1, limit: 10 }),
    ids: taskIds,
    a: {
      props: { firm: 'firm-a' },
      url: `${TASKS_A}&page=1&limit=10`,
      body: { tasks: [{ taskId: 'firm-a-late' }], totalTasks: 1 },
      ids: ['firm-a-late'],
    },
    b: {
      props: { firm: 'firm-b' },
      url: `${TASKS_B}&page=1&limit=10`,
      body: { tasks: [{ taskId: 'firm-b-now' }], totalTasks: 1 },
      ids: ['firm-b-now'],
    },
  });
});

describe('useTaskById', () => {
  const TASK_URL = (firm: string, taskId: string) => `/api/lawfirms/${firm}/tasks/${taskId}?tz=${TZ}`;

  itSendsNothingWithoutScope({
    title: 'sends nothing until both a firm and a task id exist',
    api: () => api,
    useHook: () => useTaskById('firm-a', null),
    settled: (r) => r.loading === false,
    finally: (r) => expect(r.task).toBeNull(),
  });

  it('resolves one task from its own endpoint, with the viewer timezone', async () => {
    api.getExact(TASK_URL('firm-a', 'task-1'), { taskId: 'task-1', title: 'File the brief' });

    const { result } = renderHook(() => useTaskById('firm-a', 'task-1'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.task?.title).toBe('File the brief'));
    expect(result.current.error).toBeNull();
    expect(api.calls()).toHaveLength(1);
  });

  it('reports a missing task instead of resolving to nothing', async () => {
    api.getExact(TASK_URL('firm-a', 'gone'), { status: 404, body: { error: 'Task not found' } });

    const { result } = renderHook(() => useTaskById('firm-a', 'gone'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.error).toBe('Task not found'));
    expect(result.current.task).toBeNull();
  });

  itKeepsScopeIsolated({
    title: 'does not show the previously opened task while the next one loads',
    mode: 'pending',
    api: () => api,
    useHook: ({ taskId }: { taskId: string }) => useTaskById('firm-a', taskId),
    ids: (r) => (r.task ? [r.task.taskId ?? ''] : []),
    a: { props: { taskId: 'task-1' }, url: TASK_URL('firm-a', 'task-1'), body: { taskId: 'task-1' }, ids: ['task-1'] },
    b: { props: { taskId: 'task-2' }, url: TASK_URL('firm-a', 'task-2'), body: { taskId: 'task-2' }, ids: ['task-2'] },
  });
});

/**
 * Two firms' lists mounted beside one mutation hook, so a test can see both
 * that the acting firm's list refetched and that the other firm's did not.
 * Breaking the invalidation key (dropping it, or widening it to `['tasks']`)
 * turns the refetch assertions red.
 */
function mountListsBeside<T>(useMutationHook: () => T) {
  return renderHook(() => ({
    listA: useLawfirmTasks('firm-a'),
    listB: useLawfirmTasks('firm-b'),
    hook: useMutationHook(),
  }), { wrapper: createQueryWrapper() });
}

describe('useCreateTask', () => {
  const CREATE_A = '/api/lawfirms/firm-a/tasks';

  it('creates in the firm, refetches only that firm list, then closes, resets and calls onDone', async () => {
    api.getExact(TASKS_A, sequence(
      { tasks: [{ taskId: 't1' }] },
      { tasks: [{ taskId: 't1' }, { taskId: 'created' }] },
    ));
    api.getExact(TASKS_B, { tasks: [{ taskId: 'b1' }] });
    api.postExact(CREATE_A, { taskId: 'created' });
    const onDone = jest.fn();
    const setError = jest.fn();

    const { result } = mountListsBeside(() => useCreateTask('firm-a', onDone));
    await waitFor(() => expect(taskIds(result.current.listA)).toEqual(['t1']));
    await waitFor(() => expect(taskIds(result.current.listB)).toEqual(['b1']));

    act(() => {
      result.current.hook.setOpen(true);
      result.current.hook.setTitle('Draft motion');
      result.current.hook.setMatterId('matter-3');
      result.current.hook.setClientIds(['client-1']);
    });
    await act(async () => {
      await result.current.hook.submit(setError);
    });

    const [post] = api.calls('POST');
    expect(post.pathname).toBe(CREATE_A);
    expect(post.body).toEqual(expect.objectContaining({ title: 'Draft motion', matterId: 'matter-3', status: 'open', priority: 'medium' }));
    // A task on a matter takes its clients from the matter, so the picked
    // clients are not sent alongside it.
    expect(post.body).not.toHaveProperty('clientIds');
    expect(post.body).not.toHaveProperty('lawFirmId');

    await waitFor(() => expect(taskIds(result.current.listA)).toEqual(['t1', 'created']));
    expect(api.calls('GET').filter((c) => c.pathname.endsWith('/firm-b/tasks'))).toHaveLength(1);
    expect(result.current.hook.open).toBe(false);
    expect(result.current.hook.title).toBe('');
    expect(result.current.hook.submitting).toBe(false);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(setError.mock.calls).toEqual([[null]]);
  });

  it('sends an all-day last day as the exclusive day after it, and no end when none was picked', async () => {
    // The form holds the last day the task covers; the API stores the next day.
    api.postExact(CREATE_A, { taskId: 'created' });

    const { result } = renderHook(() => useCreateTask('firm-a'), { wrapper: createQueryWrapper() });
    act(() => {
      result.current.setTitle('Trial week');
      result.current.setAllDay(true);
      result.current.setDueDate('2026-05-10T00:00');
      result.current.setEndsAt('2026-05-14');
    });
    await act(async () => {
      await result.current.submit(jest.fn());
    });
    expect(api.calls('POST')[0].body).toEqual(expect.objectContaining({ endsAt: '2026-05-15' }));

    act(() => {
      result.current.setTitle('Call client');
      result.current.setDueDate('2026-05-10T09:00');
    });
    await act(async () => {
      await result.current.submit(jest.fn());
    });
    expect(api.calls('POST')[1].body).not.toHaveProperty('endsAt');
  });

  it('opens a new task blank, dropping a draft closed without saving, with only the seed it is given', () => {
    // Every New Task button opens through this. A draft abandoned by closing
    // the modal must not come back, and nor may a matter or day it was seeded
    // with last time.
    const { result } = renderHook(() => useCreateTask('firm-a'), { wrapper: createQueryWrapper() });
    act(() => result.current.openNew({ matterId: 'matter-3', dueDate: '2026-05-10T09:00' }));
    act(() => {
      result.current.setTitle('Abandoned draft');
      result.current.setEndsAt('2026-05-10T10:00');
      result.current.setOpen(false);
    });

    act(() => result.current.openNew());

    expect(result.current.open).toBe(true);
    expect(result.current.title).toBe('');
    expect(result.current.matterId).toBe('');
    expect(result.current.dueDate).toBe('');
    expect(result.current.endsAt).toBe('');
  });

  it('sends the picked clients when the task has no matter', async () => {
    api.postExact(CREATE_A, { taskId: 'created' });

    const { result } = renderHook(() => useCreateTask('firm-a'), { wrapper: createQueryWrapper() });
    act(() => {
      result.current.setTitle('Call client');
      result.current.setClientIds(['client-1', 'client-2']);
    });
    await act(async () => {
      await result.current.submit(jest.fn());
    });

    expect(api.calls('POST')[0].body).toEqual(expect.objectContaining({ clientIds: ['client-1', 'client-2'] }));
  });

  it('keeps the form open with the server reason when the create is refused', async () => {
    api.postExact(CREATE_A, { status: 422, body: { error: 'Due date is before the matter opened' } });
    const onDone = jest.fn();
    const setError = jest.fn();

    const { result } = renderHook(() => useCreateTask('firm-a', onDone), { wrapper: createQueryWrapper() });
    act(() => {
      result.current.setOpen(true);
      result.current.setTitle('Draft motion');
    });
    await act(async () => {
      await result.current.submit(setError);
    });

    expect(setError).toHaveBeenLastCalledWith('Due date is before the matter opened');
    expect(result.current.open).toBe(true);
    expect(result.current.title).toBe('Draft motion');
    expect(result.current.submitting).toBe(false);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('refuses a blank title without sending anything', async () => {
    const setError = jest.fn();
    const { result } = renderHook(() => useCreateTask('firm-a'), { wrapper: createQueryWrapper() });
    act(() => result.current.setTitle('   '));

    await act(async () => {
      await result.current.submit(setError);
    });

    expect(setError).toHaveBeenLastCalledWith('Missing title');
    expect(api.calls()).toEqual([]);
    expect(result.current.submitting).toBe(false);
  });

  it('refuses to create without a firm, rather than posting to an unscoped url', async () => {
    const setError = jest.fn();
    const { result } = renderHook(() => useCreateTask(undefined), { wrapper: createQueryWrapper() });
    act(() => result.current.setTitle('Orphan'));

    await act(async () => {
      await result.current.submit(setError);
    });

    expect(setError).toHaveBeenLastCalledWith('Missing lawFirmId');
    expect(api.calls()).toEqual([]);
  });
});

describe('useEditTask', () => {
  const TASK_9 = '/api/lawfirms/firm-a/tasks/task-9';
  const existing = {
    taskId: 'task-9',
    id: 'task-9',
    title: 'Old title',
    description: 'notes',
    location: '',
    assignedTo: 'user-1',
    matterId: '',
    courtId: '',
    clientIds: ['client-1'],
    status: 'open',
    priority: 'high',
  } as unknown as Task;

  it('loads the task into the form, normalising a single assignee to a list', () => {
    const { result } = renderHook(() => useEditTask('firm-a'), { wrapper: createQueryWrapper() });

    act(() => result.current.openWith(existing));

    expect(result.current.open).toBe(true);
    expect(result.current.task?.taskId).toBe('task-9');
    expect(result.current.title).toBe('Old title');
    expect(result.current.assignedTo).toEqual(['user-1']);
    expect(result.current.priority).toBe('high');
  });

  it('prefills an all-day end as its last day and saves the same exclusive end back', async () => {
    api.putExact(TASK_9, { taskId: 'task-9' });
    const { result } = renderHook(() => useEditTask('firm-a'), { wrapper: createQueryWrapper() });

    act(() => result.current.openWith({
      ...existing,
      allDay: true,
      dueDate: '2026-05-10T12:00:00.000Z',
      dueDateLocalInput: '2026-05-10T00:00',
      endsAt: '2026-05-15T12:00:00.000Z',
    } as Task));
    // The 10th through the 14th.
    expect(result.current.endsAt).toBe('2026-05-14');

    await act(async () => {
      await result.current.save(jest.fn());
    });
    expect(api.calls('PUT')[0].body).not.toHaveProperty('endsAt');
  });

  it('keeps both instants when editing a task during the repeated DST hour', async () => {
    api.putExact(TASK_9, { taskId: 'task-9' });
    const { result } = renderHook(() => useEditTask('firm-a'), { wrapper: createQueryWrapper() });
    act(() => result.current.openWith({ ...existing, allDay: false,
      dueDate: '2026-11-01T09:00:00.000Z', dueAt: '2026-11-01T09:00:00.000Z', dueDateLocalInput: '2026-11-01T01:00',
      endsAt: '2026-11-01T09:30:00.000Z', endsAtLocalInput: '2026-11-01T01:30',
    } as Task));
    act(() => result.current.setTitle('Renamed'));
    await act(async () => { await result.current.save(jest.fn()); });
    const body = api.calls('PUT')[0].body as { dueDate: string; endsAt: string };
    expect(body).not.toHaveProperty('dueDate');
    expect(body).not.toHaveProperty('endsAt');
  });

  // The task may have opened from a cached list older than a resize made in
  // Google and polled in since; resending its end would undo that change.
  it('sends no due date, end or all-day flag when only the title changes', async () => {
    api.putExact(TASK_9, { taskId: 'task-9' });
    const { result } = renderHook(() => useEditTask('firm-a'), { wrapper: createQueryWrapper() });
    act(() => result.current.openWith({ ...existing, allDay: false,
      dueDate: '2026-05-10T20:00:00.000Z', dueDateLocalInput: '2026-05-10T13:00',
      endsAt: '2026-05-10T21:00:00.000Z', endsAtLocalInput: '2026-05-10T14:00',
    } as Task));
    act(() => result.current.setTitle('Renamed'));
    await act(async () => { await result.current.save(jest.fn()); });

    const body = api.calls('PUT')[0].body as Record<string, unknown>;
    expect(body.title).toBe('Renamed');
    expect(body).not.toHaveProperty('dueDate');
    expect(body).not.toHaveProperty('endsAt');
    expect(body).not.toHaveProperty('allDay');
  });

  // The server carries the stored end along with a moved due date, keeping a
  // length the cached copy may not know about.
  it('sends the moved due date without the end that only followed it', async () => {
    api.putExact(TASK_9, { taskId: 'task-9' });
    const { result } = renderHook(() => useEditTask('firm-a'), { wrapper: createQueryWrapper() });
    act(() => result.current.openWith({ ...existing, allDay: false,
      dueDate: '2026-05-10T20:00:00.000Z', dueDateLocalInput: '2026-05-10T13:00',
      endsAt: '2026-05-10T21:00:00.000Z', endsAtLocalInput: '2026-05-10T14:00',
    } as Task));
    act(() => { result.current.setDueDate('2026-05-11T13:00'); result.current.setEndsAt('2026-05-11T14:00'); });
    await act(async () => { await result.current.save(jest.fn()); });

    const body = api.calls('PUT')[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ dueDate: '2026-05-11T13:00', allDay: false });
    expect(body).not.toHaveProperty('endsAt');
  });

  it('sends an end the user picked along with the moved due date', async () => {
    api.putExact(TASK_9, { taskId: 'task-9' });
    const { result } = renderHook(() => useEditTask('firm-a'), { wrapper: createQueryWrapper() });
    act(() => result.current.openWith({ ...existing, allDay: false,
      dueDate: '2026-05-10T20:00:00.000Z', dueDateLocalInput: '2026-05-10T13:00',
      endsAt: '2026-05-10T21:00:00.000Z', endsAtLocalInput: '2026-05-10T14:00',
    } as Task));
    act(() => { result.current.setDueDate('2026-05-11T13:00'); result.current.setEndsAt('2026-05-11T16:00'); });
    await act(async () => { await result.current.save(jest.fn()); });

    expect(api.calls('PUT')[0].body).toMatchObject({ dueDate: '2026-05-11T13:00', endsAt: '2026-05-11T16:00' });
  });

  // The server reads a due date sent without the flag as all-day only when it
  // is a bare day, and the form's all-day value is 'YYYY-MM-DDT00:00'. Leaving
  // the flag out would turn the task into a timed one at midnight.
  it('sends the all-day flag with a moved due date, even when it did not change', async () => {
    api.putExact(TASK_9, { taskId: 'task-9' });
    const { result } = renderHook(() => useEditTask('firm-a'), { wrapper: createQueryWrapper() });
    act(() => result.current.openWith({ ...existing, allDay: true,
      dueDate: '2026-05-10T12:00:00.000Z', dueDateLocalInput: '2026-05-10T00:00',
    } as Task));
    act(() => result.current.setDueDate('2026-05-20T00:00'));
    await act(async () => { await result.current.save(jest.fn()); });

    expect(api.calls('PUT')[0].body).toMatchObject({ dueDate: '2026-05-20T00:00', allDay: true });
  });

  it('sends null for a cleared end, so the stored one is removed rather than kept', async () => {
    api.putExact(TASK_9, { taskId: 'task-9' });
    const { result } = renderHook(() => useEditTask('firm-a'), { wrapper: createQueryWrapper() });

    act(() => result.current.openWith({
      ...existing,
      dueDate: '2026-05-10T17:00:00.000Z',
      dueDateLocalInput: '2026-05-10T13:00',
      endsAt: '2026-05-10T19:30:00.000Z',
      endsAtLocalInput: '2026-05-10T15:30',
    } as Task));
    expect(result.current.endsAt).toBe('2026-05-10T15:30');
    act(() => result.current.setEndsAt(''));

    await act(async () => {
      await result.current.save(jest.fn());
    });
    expect(api.calls('PUT')[0].body).toHaveProperty('endsAt', null);
  });

  it('saves to the task url, clears blank optional fields, and refetches only the firm list', async () => {
    api.getExact(TASKS_A, sequence(
      { tasks: [{ taskId: 'task-9', title: 'Old title' }] },
      { tasks: [{ taskId: 'task-9', title: 'New title' }] },
    ));
    api.getExact(TASKS_B, { tasks: [{ taskId: 'b1' }] });
    api.putExact(TASK_9, { taskId: 'task-9' });
    const onDone = jest.fn();

    const { result } = mountListsBeside(() => useEditTask('firm-a', onDone));
    await waitFor(() => expect(taskIds(result.current.listA)).toEqual(['task-9']));
    await waitFor(() => expect(taskIds(result.current.listB)).toEqual(['b1']));

    act(() => result.current.hook.openWith(existing));
    act(() => result.current.hook.setTitle('New title'));
    await act(async () => {
      await result.current.hook.save(jest.fn());
    });

    const [put] = api.calls('PUT');
    expect(put.pathname).toBe(TASK_9);
    // Blank optional fields are sent as explicit nulls so an edit can clear
    // them; omitting them would leave the old location and court in place.
    expect(put.body).toEqual(expect.objectContaining({
      title: 'New title',
      location: null,
      courtId: null,
      assignedTo: ['user-1'],
      clientIds: ['client-1'],
      priority: 'high',
    }));

    await waitFor(() => expect(result.current.listA.tasks[0].title).toBe('New title'));
    expect(api.calls('GET').filter((c) => c.pathname.endsWith('/firm-b/tasks'))).toHaveLength(1);
    expect(result.current.hook.open).toBe(false);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('sends an explicit null when the due date was cleared, so the server drops it', async () => {
    api.putExact(TASK_9, { taskId: 'task-9' });
    const dated = { ...existing, dueDate: '2026-05-01T12:00:00.000Z', dueDateLocalInput: '2026-05-01T12:00' } as unknown as Task;

    const { result } = renderHook(() => useEditTask('firm-a'), { wrapper: createQueryWrapper() });
    act(() => result.current.openWith(dated));
    expect(result.current.dueDate).toBe('2026-05-01T12:00');
    act(() => result.current.setDueDate(''));
    await act(async () => {
      await result.current.save(jest.fn());
    });

    // Omitting the key leaves the old date in place on the server, so a cleared
    // field would come back as the date the user just removed.
    const [put] = api.calls('PUT');
    expect((put.body as Record<string, unknown>).dueDate).toBeNull();
  });

  it('shows the server reason when clearing the due date of a recurring task is refused', async () => {
    api.putExact(TASK_9, { status: 400, body: { error: 'A recurring task needs a due date' } });
    const setError = jest.fn();

    const { result } = renderHook(() => useEditTask('firm-a'), { wrapper: createQueryWrapper() });
    act(() => result.current.openWith({ ...existing, dueDate: '2026-05-01T12:00:00.000Z' } as unknown as Task));
    act(() => result.current.setDueDate(''));
    await act(async () => {
      await result.current.save(setError);
    });

    expect(setError).toHaveBeenLastCalledWith('A recurring task needs a due date');
    expect(result.current.open).toBe(true);
  });

  it('reports a refused save and leaves the form open', async () => {
    api.putExact(TASK_9, { status: 409, body: { error: 'Task was changed by someone else' } });
    const setError = jest.fn();
    const onDone = jest.fn();

    const { result } = renderHook(() => useEditTask('firm-a', onDone), { wrapper: createQueryWrapper() });
    act(() => result.current.openWith(existing));
    await act(async () => {
      await result.current.save(setError);
    });

    expect(setError).toHaveBeenLastCalledWith('Task was changed by someone else');
    expect(result.current.open).toBe(true);
    expect(result.current.submitting).toBe(false);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('refuses to save before a task was opened, and a cleared title, without sending anything', async () => {
    const setError = jest.fn();
    const { result } = renderHook(() => useEditTask('firm-a'), { wrapper: createQueryWrapper() });

    await act(async () => {
      await result.current.save(setError);
    });
    expect(setError).toHaveBeenLastCalledWith('Missing taskId');

    act(() => result.current.openWith(existing));
    act(() => result.current.setTitle(''));
    await act(async () => {
      await result.current.save(setError);
    });
    expect(setError).toHaveBeenLastCalledWith('Missing title');
    expect(api.calls()).toEqual([]);
  });
});

describe('useBulkTasks', () => {
  const BULK = (op: string) => `/api/lawfirms/firm-a/tasks/${op}`;

  type BulkHook = ReturnType<typeof useBulkTasks>;
  const OPS: Array<{ name: string; op: string; run: (h: BulkHook) => Promise<unknown>; body: unknown }> = [
    { name: 'bulkDelete', op: 'bulk-delete', run: (h) => h.bulkDelete(['t1', 't2']), body: { taskIds: ['t1', 't2'] } },
    { name: 'bulkStatus', op: 'bulk-status', run: (h) => h.bulkStatus(['t1'], 'completed'), body: { taskIds: ['t1'], status: 'completed' } },
    { name: 'bulkMatter', op: 'bulk-matter', run: (h) => h.bulkMatter(['t1'], null), body: { taskIds: ['t1'], matterId: null } },
  ];

  describe.each(OPS)('$name', ({ op, run, body }) => {
    it('posts the selection and refetches only the acting firm list', async () => {
      api.getExact(TASKS_A, sequence({ tasks: [{ taskId: 't1' }] }, { tasks: [] }));
      api.getExact(TASKS_B, { tasks: [{ taskId: 'b1' }] });
      api.postExact(BULK(op), { updated: 1 });
      const onDone = jest.fn();

      const { result } = mountListsBeside(() => useBulkTasks('firm-a', onDone));
      await waitFor(() => expect(taskIds(result.current.listA)).toEqual(['t1']));
      await waitFor(() => expect(taskIds(result.current.listB)).toEqual(['b1']));

      await act(async () => {
        await run(result.current.hook);
      });

      expect(api.calls('POST').map((c) => [c.pathname, c.body])).toEqual([[BULK(op), body]]);
      await waitFor(() => expect(taskIds(result.current.listA)).toEqual([]));
      expect(api.calls('GET').filter((c) => c.pathname.endsWith('/firm-b/tasks'))).toHaveLength(1);
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(result.current.hook.busy).toBe(false);
      expect(result.current.hook.error).toBeNull();
    });

    it('surfaces a refusal and does not call onDone', async () => {
      api.postExact(BULK(op), { status: 403, body: { error: 'Permission denied' } });
      const onDone = jest.fn();

      const { result } = renderHook(() => useBulkTasks('firm-a', onDone), { wrapper: createQueryWrapper() });
      await act(async () => {
        await run(result.current);
      });

      expect(result.current.error).toBe('Permission denied');
      expect(result.current.busy).toBe(false);
      expect(onDone).not.toHaveBeenCalled();
    });
  });

  // The bulk routes answer 200 even when rows were refused (legal hold, a
  // missing permission on one matter), listing them in `failed`/`errors`. The
  // hook used to read none of it, so the dialog closed and the refused rows
  // just stayed where they were with no explanation.
  describe.each([
    { name: 'bulkDelete', op: 'bulk-delete', run: (h: BulkHook) => h.bulkDelete(['t1', 't2']), count: { deleted: 1 }, verb: 'deleted' },
    { name: 'bulkStatus', op: 'bulk-status', run: (h: BulkHook) => h.bulkStatus(['t1', 't2'], 'completed'), count: { updated: 1 }, verb: 'updated' },
    { name: 'bulkMatter', op: 'bulk-matter', run: (h: BulkHook) => h.bulkMatter(['t1', 't2'], 'm1'), count: { updated: 1 }, verb: 'updated' },
  ])('$name reports a partial result', ({ op, run, count, verb }) => {
    it('keeps the reason for the refused row, and still refreshes for the one that went through', async () => {
      api.postExact(BULK(op), { requested: 2, ...count, failed: ['t2'], errors: { t2: 'Task is under legal hold' } });
      const onDone = jest.fn();

      const { result } = renderHook(() => useBulkTasks('firm-a', onDone), { wrapper: createQueryWrapper() });
      let outcome: unknown;
      await act(async () => {
        outcome = await run(result.current);
      });

      expect(result.current.error).toBe(`1 of 2 tasks ${verb}. 1 could not be ${verb}: Task is under legal hold`);
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(outcome).toEqual(expect.objectContaining({ failed: ['t2'] }));
    });

    it('returns nothing when the whole request was refused, so a caller can keep the selection', async () => {
      api.postExact(BULK(op), { status: 403, body: { error: 'Permission denied' } });

      const { result } = renderHook(() => useBulkTasks('firm-a'), { wrapper: createQueryWrapper() });
      let outcome: unknown = 'unset';
      await act(async () => {
        outcome = await run(result.current);
      });

      expect(outcome).toBeNull();
    });
  });

  it('refuses a bulk action without a firm and sends nothing', async () => {
    const { result } = renderHook(() => useBulkTasks(undefined), { wrapper: createQueryWrapper() });

    await act(async () => {
      await result.current.bulkDelete(['t1']);
    });

    expect(result.current.error).toBe('Missing lawFirmId');
    expect(api.calls()).toEqual([]);
  });
});

describe('the form setters write the field they are named for', () => {
  // Each setter is a one-line lambda onto a shared reducer, so a copy-paste
  // slip (setLocation writing description) leaves a field that never changes
  // and another that changes on its own. Distinct values per field make a
  // crossed wire visible.
  const FIELDS: Array<[string, string, unknown]> = [
    ['setTitle', 'title', 'T'],
    ['setDescription', 'description', 'D'],
    ['setLocation', 'location', 'L'],
    ['setDueDate', 'dueDate', '2026-10-02'],
    ['setAllDay', 'allDay', true],
    ['setAssignedTo', 'assignedTo', ['u1']],
    ['setMatterId', 'matterId', 'm1'],
    ['setCourtId', 'courtId', 'court-1'],
    ['setClientIds', 'clientIds', ['c1']],
    ['setReminderRecipientIds', 'reminderRecipientIds', ['r1']],
    ['setSendReminderEarly', 'sendReminderEarly', true],
    ['setStatus', 'status', 'in_progress'],
    ['setPriority', 'priority', 'urgent'],
    ['setRecurrenceEnabled', 'recurrenceEnabled', true],
    ['setRecurrencePattern', 'recurrencePattern', 'monthly'],
    ['setRecurrenceInterval', 'recurrenceInterval', 3],
    ['setRecurrenceDaysOfWeek', 'recurrenceDaysOfWeek', [1, 3]],
    ['setRecurrenceDayOfMonth', 'recurrenceDayOfMonth', 15],
    ['setRecurrenceEndDate', 'recurrenceEndDate', '2027-01-01'],
    ['setRecurrenceMaxOccurrences', 'recurrenceMaxOccurrences', 6],
    ['setDependencies', 'dependencies', ['t0']],
  ];

  it.each<[string, () => unknown]>([
    ['useCreateTask', () => useCreateTask('firm-a')],
    ['useEditTask', () => useEditTask('firm-a')],
  ])('%s', (_name, useForm) => {
    const { result } = renderHook(() => useForm(), { wrapper: createQueryWrapper() });
    const form = () => result.current as Record<string, unknown>;

    act(() => {
      for (const [setter, , value] of FIELDS) (form()[setter] as (v: unknown) => void)(value);
    });

    expect(Object.fromEntries(FIELDS.map(([, field]) => [field, form()[field]])))
      .toEqual(Object.fromEntries(FIELDS.map(([, field, value]) => [field, value])));
    expect(api.calls()).toEqual([]);
  });
});
