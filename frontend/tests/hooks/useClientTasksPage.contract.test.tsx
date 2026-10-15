/**
 * Offline contract coverage for a client's rolled-up tasks page.
 *
 * The scoping id (`clientId`) lives in the QUERY STRING on the shared `/tasks`
 * endpoint, not the path, so a suffix match on the pathname alone cannot
 * distinguish two clients - this uses `getExact`. Keyed via
 * `[...clientTasksKey(lawFirmId, clientId), page, rowsPerPage, debouncedSearch]`
 * with bare `placeholderData: keepPreviousData`, the same shape already found
 * and fixed as a cross-entity leak in `useTasks`/`useClients`.
 */
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/requestDeduplicator');

import { renderHook, waitFor } from '@testing-library/react';

import useClientTasksPage from '@/hooks/clientHooks/useClientTasksPage';
import { getUserTimeZone } from '@/lib/utils/timezone';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const TZ = encodeURIComponent(getUserTimeZone());
const TASKS_A = `/api/lawfirms/firm-a/tasks?tz=${TZ}`;

const api = setupApiMock();

describe('useClientTasksPage offline contract', () => {
  it('does not request tasks before a firm and client exist', async () => {
    const { result } = renderHook(
      () => useClientTasksPage(undefined, undefined),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.calls()).toHaveLength(0);
  });

  it('fetches the exact client-scoped tasks endpoint', async () => {
    api.getExact(`${TASKS_A}&page=1&limit=10&clientId=client-a`, { tasks: [{ taskId: 'task-a' }], totalTasks: 1 });

    const { result } = renderHook(
      () => useClientTasksPage('firm-a', 'client-a'),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.tasks.map((t) => t.taskId)).toEqual(['task-a']));
  });

  // Client B's request is still pending here. Client A's tasks must not
  // render as though they belong to client B while it loads.
  itKeepsScopeIsolated({
    title: 'does not show one client the tasks of another after a scope change',
    mode: 'pending',
    api: () => api,
    useHook: ({ clientId }: { clientId: string }) => useClientTasksPage('firm-a', clientId),
    ids: (r) => r.tasks.map((t) => t.taskId!),
    a: { props: { clientId: 'client-a' }, url: `${TASKS_A}&page=1&limit=10&clientId=client-a`, body: { tasks: [{ taskId: 'client-a-task' }], totalTasks: 1 }, ids: ['client-a-task'] },
    b: { props: { clientId: 'client-b' }, url: `${TASKS_A}&page=1&limit=10&clientId=client-b`, body: { tasks: [{ taskId: 'client-b-task' }], totalTasks: 1 }, ids: ['client-b-task'] },
  });
});
