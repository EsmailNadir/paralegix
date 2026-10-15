/**
 * The firm tasks list: `RequirePermission` gating `TasksGrid`, the entry point
 * for every task in the firm.
 *
 * `tasks.service`, `users.service` and `requestDeduplicator` run for real
 * against a faked transport, so a wrong url, a swallowed error, or a stale
 * response reaching a switched firm fails the spec instead of a stubbed hook
 * quietly returning whatever the test handed it.
 */
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/users.service');
jest.unmock('@/services/requestDeduplicator');

const useParamsMock = jest.fn();
const useSearchParamsMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/tasks',
  useParams: () => useParamsMock(),
  useSearchParams: () => useSearchParamsMock(),
}));

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  // A stable fn, unlike the global stub in `tests/setup.ts`, which hands out a
  // fresh `jest.fn()` per call so nothing it received can be asserted.
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import LawFirmTasksPage from '@/app/lawfirm/[lawFirmId]/tasks/page';
import { setupApiMock, sequence } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, grantOutsider, resetPermissions } from '../../../support/permissions';
import type { Task } from '@/types';

const FIRM_A = 'firm-a';
const FIRM_B = 'firm-b';
const API = 'http://localhost:5001/api';

const api = setupApiMock();

function tasksBaseUrl(firmId: string): string {
  return `/lawfirms/${firmId}/tasks`;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    taskId: 'task-1',
    lawFirmId: FIRM_A,
    title: 'File motion',
    status: 'open',
    priority: 'medium',
    dueDate: '2026-01-15T12:00:00.000Z',
    matterName: 'Smith v. Jones',
    ...overrides,
  } as Task;
}

/** Every route the grid fetches on mount for the default (grid) view. */
function seedTasksWorkspace(opts: { firmId?: string; tasks?: Task[]; totalTasks?: number } = {}) {
  const firmId = opts.firmId ?? FIRM_A;
  const rows = opts.tasks ?? [];
  api.get(tasksBaseUrl(firmId), { tasks: rows, totalTasks: opts.totalTasks ?? rows.length });
  api.getExact(`${API}/users/lawfirm/${firmId}/users`, []);
}

function renderTasksPage() {
  return renderWithProviders(<LawFirmTasksPage />);
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A });
  useSearchParamsMock.mockReturnValue(new URLSearchParams());
});

afterEach(() => {
  resetPermissions();
  jest.clearAllMocks();
});

describe('loaded content', () => {
  it('shows the real tasks returned by the server', async () => {
    seedTasksWorkspace({
      tasks: [task(), task({ id: 'task-2', taskId: 'task-2', title: 'Serve papers', status: 'completed' })],
      totalTasks: 2,
    });

    renderTasksPage();

    expect(await screen.findByText('File motion')).toBeInTheDocument();
    expect(screen.getByText('Serve papers')).toBeInTheDocument();
    expect(screen.getByText('Tasks (2)')).toBeInTheDocument();
  });
});

describe('a meaningful empty state', () => {
  it('says no tasks were found rather than rendering a blank grid', async () => {
    seedTasksWorkspace();

    renderTasksPage();

    expect(await screen.findByText('No tasks found')).toBeInTheDocument();
    expect(screen.getByText('Try adjusting your search or filters.')).toBeInTheDocument();
    expect(screen.getByText('Tasks (0)')).toBeInTheDocument();
  });
});

describe('an API failure, with retry', () => {
  it('tells the user the list failed to load rather than showing an empty grid', async () => {
    seedTasksWorkspace();
    api.get(tasksBaseUrl(FIRM_A), { status: 500, body: { error: 'tasks service unavailable' } });

    renderTasksPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/tasks service unavailable/i);
    expect(screen.queryByText('No tasks found')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('recovers the real list once the retry succeeds', async () => {
    seedTasksWorkspace();
    api.get(tasksBaseUrl(FIRM_A), sequence(
      { status: 500, body: { error: 'tasks service unavailable' } },
      { tasks: [task()], totalTasks: 1 },
    ));

    renderTasksPage();

    const retry = await screen.findByRole('button', { name: 'Try again' });
    await userEvent.click(retry);

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(await screen.findByText('File motion')).toBeInTheDocument();
  });
});

describe('narrow role behavior', () => {
  it('opens the grid for a baseline member without the write controls', async () => {
    grantBaselineMember();
    seedTasksWorkspace({ tasks: [task()], totalTasks: 1 });

    renderTasksPage();

    expect(await screen.findByText('File motion')).toBeInTheDocument();
    // tasks.view is baseline, but create/update/delete are not.
    expect(screen.queryByText('Create New Task')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('turns away a caller with no membership at all', async () => {
    grantOutsider();
    seedTasksWorkspace({ tasks: [task()], totalTasks: 1 });

    renderTasksPage();

    expect(await screen.findByText('You do not have access to this area')).toBeInTheDocument();
    // TasksGrid is mounted INSIDE RequirePermission, so a refused viewer's
    // render never reaches the component that would fire the request.
    expect(api.callsTo('/tasks')).toHaveLength(0);
  });
});

describe('a successful action: deleting a task', () => {
  it('removes the task and refreshes the list', async () => {
    seedTasksWorkspace();
    // First load answers with the seeded task; the refresh AFTER a successful
    // delete re-requests the same URL and gets the now-empty list.
    api.get(tasksBaseUrl(FIRM_A), sequence(
      { tasks: [task()], totalTasks: 1 },
      { tasks: [], totalTasks: 0 },
    ));
    api.deleteExact(`${API}${tasksBaseUrl(FIRM_A)}/task-1`, { message: 'Task deleted' });

    renderTasksPage();

    await screen.findByText('File motion');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/File motion/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('File motion')).not.toBeInTheDocument());
    expect(await screen.findByText('No tasks found')).toBeInTheDocument();
    expect(api.callsTo('/tasks/task-1').filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
});

describe('a refused action: the delete fails', () => {
  it('tells the user the task was not deleted, and leaves it in the list', async () => {
    seedTasksWorkspace({ tasks: [task()], totalTasks: 1 });
    api.deleteExact(`${API}${tasksBaseUrl(FIRM_A)}/task-1`, {
      status: 409, body: { error: 'This task has incomplete dependents and cannot be deleted' },
    });

    renderTasksPage();

    await screen.findByText('File motion');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/incomplete dependents and cannot be deleted/i)).toBeInTheDocument();
    // Still in the list - the delete never actually happened.
    expect(screen.getByText('File motion')).toBeInTheDocument();
  });
});

describe('a law firm switch while a request is pending', () => {
  it('never lets a slow response for the old firm land as the new firm\'s task list', async () => {
    seedTasksWorkspace({ firmId: FIRM_A });
    seedTasksWorkspace({ firmId: FIRM_B, tasks: [task({ id: 'task-b', taskId: 'task-b', lawFirmId: FIRM_B, title: 'Firm B Task' })], totalTasks: 1 });
    // Registered AFTER `seedTasksWorkspace` so it wins (`apiMock` matches the
    // most-recently-registered handler first): firm A's initial load itself
    // must be the slow response, still in flight when the viewer switches.
    api.get(tasksBaseUrl(FIRM_A), { delayMs: 200, body: { tasks: [task({ title: 'Firm A Task' })], totalTasks: 1 } });

    const { rerender } = renderTasksPage();
    await screen.findByText('Firm A Task');

    useParamsMock.mockReturnValue({ lawFirmId: FIRM_B });
    rerender(<LawFirmTasksPage />);

    // Firm A's task must not keep rendering, full-opacity and clickable, as
    // though it belonged to firm B just because `useLawfirmTasks` carries
    // `placeholderData` across the query-key change - firm B's own tasks read
    // is still ~200ms from resolving.
    expect(screen.queryByText('Firm A Task')).not.toBeInTheDocument();

    expect(await screen.findByText('Firm B Task')).toBeInTheDocument();

    // Even once firm A's slow response finally arrives, it must not overwrite
    // the list now attributed to firm B.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByText('Firm B Task')).toBeInTheDocument();
    expect(screen.queryByText('Firm A Task')).not.toBeInTheDocument();
  });
});
