/**
 * What the Calendar page sends when its side panel flips a task's status.
 *
 * The toggle changes the status and nothing else. The task it holds is the
 * calendar's cached copy, which can be older than the server's: a due date
 * moved in Google and polled in since, or an assignee changed in another tab.
 * Resending that copy's other fields would quietly undo those changes.
 *
 * The panel is replaced by a stub that hands its callbacks to the spec, and
 * the tasks service runs for real against the transport mock, so the spec
 * reads the request body the server would receive.
 */
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act } from '@testing-library/react';
import Calendar from '@/components/calendarComp/Calendar';
import type { Task } from '@/types';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

jest.mock('@/hooks/calendarHooks/useCalendarWindowData', () => ({
  __esModule: true,
  default: () => ({ matterEvents: [], clientEvents: [], externalEvents: [], tasks: [], paymentDates: [], loading: false,
    fetching: false, rangeUnloaded: false, error: null, refreshTasks: jest.fn(), refetch: jest.fn() }),
}));
jest.mock('@/hooks/calendarHooks/useNextUpTask', () => ({ __esModule: true, default: () => ({ nextUpTask: null, loading: false }) }));
jest.mock('@/hooks/calendarHooks/useUserSyncSettings', () => ({ __esModule: true, default: () => ({ syncFlags: null }) }));
jest.mock('@/hooks/useUsers', () => ({ useLawFirmUsers: () => ({ users: [], loading: false }) }));

let panel: { onTaskUpdate: (task: Task) => Promise<void> };
jest.mock('@/components/calendarComp/CalendarSidePanel', () => ({
  __esModule: true,
  default: function PanelStub(props: typeof panel) {
    panel = props;
    return null;
  },
}));

let api: ApiMock;
beforeEach(() => { api = installApiMock(); });
afterEach(() => api.restore());

it('sends only the new status when a task is marked completed', async () => {
  api.put('/tasks/task-9', { taskId: 'task-9' });
  renderWithProviders(<Calendar />);

  await act(() => panel.onTaskUpdate({
    id: 'task-9', taskId: 'task-9', title: 'Cached title', description: 'Cached notes', status: 'completed',
    dueDate: '2026-09-05T20:00:00.000Z', dueDateLocalInput: '2026-09-05T13:00',
    endsAt: '2026-09-05T21:00:00.000Z', assignedTo: ['user-1'], matterId: 'matter-1', allDay: false,
  } as unknown as Task));

  const [put] = api.calls('PUT');
  expect(put.pathname).toMatch(/\/tasks\/task-9$/);
  expect(put.body).toEqual({ status: 'completed' });
});
