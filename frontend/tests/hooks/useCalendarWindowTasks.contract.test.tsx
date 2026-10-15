/**
 * Offline contract coverage for the calendar's window-bounded tasks read.
 *
 * Keyed `["tasks", lawFirmId, "calendarWindow", from, to]` with bare
 * `placeholderData: keepPreviousData`. Only ever consumed through
 * `useCalendarWindowData` today, which suppresses stale-firm data at its own
 * call site, but the hook itself still needs the guard for any other/future
 * caller, matching how `usePaymentDates` was fixed under the same reasoning.
 */
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/requestDeduplicator');

// Mocked so the timezone test below can change what the hook AND the (real,
// unmocked) service observe without touching the OS clock.
jest.mock('@/lib/utils/timezone', () => ({ getUserTimeZone: jest.fn(() => 'America/New_York') }));

import { renderHook, waitFor } from '@testing-library/react';

import useCalendarWindowTasks from '@/hooks/calendarHooks/useCalendarWindowTasks';
import { getUserTimeZone } from '@/lib/utils/timezone';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const WINDOW = { key: '2026-09', from: '2026-09-01', to: '2026-09-30' };
const DECEMBER_WINDOW = { key: '2026-12', from: '2026-12-01', to: '2026-12-31' };

const api = setupApiMock();

beforeEach(() => {
  (getUserTimeZone as jest.Mock).mockReturnValue('America/New_York');
});

describe('useCalendarWindowTasks offline contract', () => {
  it('fetches the exact firm tasks endpoint', async () => {
    api.get('/lawfirms/firm-a/tasks', { tasks: [{ taskId: 'task-a' }] });

    const { result } = renderHook(() => useCalendarWindowTasks('firm-a', WINDOW), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.tasks.map((t) => t.taskId)).toEqual(['task-a']));
  });

  // Firm B's window request is still pending here (the window itself did not
  // change, only the firm). Firm A's tasks must not render as though they
  // belong to firm B while it loads.
  itKeepsScopeIsolated({
    title: 'does not show one firm the tasks of another after a scope change',
    mode: 'pending',
    match: 'suffix',
    api: () => api,
    useHook: ({ lawFirmId }: { lawFirmId: string }) => useCalendarWindowTasks(lawFirmId, WINDOW),
    ids: (r) => r.tasks.map((t) => t.taskId!),
    a: { props: { lawFirmId: 'firm-a' }, url: '/lawfirms/firm-a/tasks', body: { tasks: [{ taskId: 'firm-a-task' }] }, ids: ['firm-a-task'] },
    b: { props: { lawFirmId: 'firm-b' }, url: '/lawfirms/firm-b/tasks', body: { tasks: [{ taskId: 'firm-b-task' }] }, ids: ['firm-b-task'] },
  });

  it('sends the exact window bounds and viewer timezone as parameters', async () => {
    api.get('/lawfirms/firm-a/tasks', { tasks: [] });

    renderHook(() => useCalendarWindowTasks('firm-a', WINDOW), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(api.calls('GET')).toHaveLength(1));
    const [call] = api.calls('GET');
    expect(call.query.dueFrom).toEqual([WINDOW.from]);
    expect(call.query.dueTo).toEqual([WINDOW.to]);
    expect(call.query.includeSpanning).toEqual(['true']);
    expect(call.query.tz).toEqual(['America/New_York']);
  });

  it('issues a fresh request when navigating to a non-overlapping window', async () => {
    api.get('/lawfirms/firm-a/tasks', (call) => ({
      tasks: call.query.dueFrom?.[0] === WINDOW.from ? [{ taskId: 'september-task' }] : [{ taskId: 'december-task' }],
    }));

    const { result, rerender } = renderHook(
      ({ window }: { window: typeof WINDOW }) => useCalendarWindowTasks('firm-a', window),
      { initialProps: { window: WINDOW }, wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(result.current.tasks.map((t) => t.taskId)).toEqual(['september-task']));

    rerender({ window: DECEMBER_WINDOW });

    await waitFor(() => expect(result.current.tasks.map((t) => t.taskId)).toEqual(['december-task']));
    expect(api.calls('GET')).toHaveLength(2);
  });

  describe('timezone-specific query keys', () => {
    it('does not keep rendering the old zone\'s tasks after the viewer\'s timezone changes', async () => {
      // `listLawFirmTasksPaged` sends the same `tz` the day-only `dueFrom`/`dueTo`
      // bounds are resolved against server-side, so identical bounds in a
      // different zone are a different UTC range of due dates.
      api.get('/lawfirms/firm-a/tasks', (call) => ({
        tasks: call.query.tz?.[0] === 'Asia/Karachi' ? [{ taskId: 'karachi-task' }] : [{ taskId: 'new-york-task' }],
      }));

      const { result, rerender } = renderHook(
        () => useCalendarWindowTasks('firm-a', WINDOW),
        { wrapper: createQueryWrapper() },
      );
      await waitFor(() => expect(result.current.tasks.map((t) => t.taskId)).toEqual(['new-york-task']));

      (getUserTimeZone as jest.Mock).mockReturnValue('Asia/Karachi');
      rerender();

      await waitFor(() => expect(result.current.tasks.map((t) => t.taskId)).toEqual(['karachi-task']));
      expect(api.calls('GET')).toHaveLength(2);
    });
  });
});
