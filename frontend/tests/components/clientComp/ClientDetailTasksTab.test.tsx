/**
 * The Tasks tab on a client's page.
 *
 * A client's tasks roll up across every matter they are on, so the list is
 * paged and searched by the SERVER (`useClientTasksPage`). It used to hand one
 * page of ten to a tab that filters client-side and has no pager, so a client
 * with fifteen tasks showed ten and no way to reach the rest.
 *
 * The client and tasks services run for real against a faked transport, so the
 * page and search parameters that leave the page are the ones asserted.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/users.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClientDetail from '@/components/clientComp/ClientDetail';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { grantBaselineMember, resetPermissions } from '../../support/permissions';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const CLIENT_URL = '/lawfirms/firm-1/clients/client-1';

let api: ApiMock;

function makeTasks(count: number, statusOf: (i: number) => string = () => 'open') {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    taskId: `t${i + 1}`,
    title: `Task ${String(i + 1).padStart(2, '0')}`,
    status: statusOf(i),
    priority: 'medium',
  }));
}

/** Answers `GET /tasks` the way the server does: the requested page of the matching set. */
function serveTasks(all: ReturnType<typeof makeTasks>) {
  api.get('/lawfirms/firm-1/tasks', (call) => {
    const page = Number(call.query.page?.[0] ?? 1);
    const limit = Number(call.query.limit?.[0] ?? 10);
    const search = (call.query.search?.[0] ?? '').toLowerCase();
    const status = call.query.status?.[0];
    const matching = all
      .filter((t) => !search || t.title.toLowerCase().includes(search))
      .filter((t) => !status || t.status === status);
    return { tasks: matching.slice((page - 1) * limit, page * limit), totalTasks: matching.length };
  });
}

const taskReads = () => api.callsTo('/lawfirms/firm-1/tasks').filter((c) => c.method === 'GET');

async function renderOnTasksTab() {
  renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);
  await screen.findByRole('heading', { name: /Dana Client/ });
  fireEvent.click(screen.getByRole('button', { name: /^Tasks/ }));
}

beforeEach(() => {
  api = installApiMock();
  // The page also asks for conversations, relationships, events and lookups this spec does not examine.
  api.allowUnhandled();
  __resetDuplicateRequestGuard();
  api.get(CLIENT_URL, { client: { id: 'client-1', name: 'Dana Client', email: 'dana@example.com', clientType: 'person' } });
  api.get(`${CLIENT_URL}/summary`, { clientId: 'client-1', matters: null, billing: null });
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

describe('paging a long task list', () => {
  // Red if: the tab goes back to rendering only the first server page with no pager.
  it('shows the first ten of fifteen tasks, with the range, and reaches the rest on the next page', async () => {
    serveTasks(makeTasks(15));

    await renderOnTasksTab();

    expect(await screen.findByText('Task 01')).toBeInTheDocument();
    expect(screen.getByText('Task 10')).toBeInTheDocument();
    expect(screen.queryByText('Task 11')).not.toBeInTheDocument();
    expect(screen.getByText('1–10 of 15')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Task 11')).toBeInTheDocument();
    expect(screen.getByText('Task 15')).toBeInTheDocument();
    expect(screen.queryByText('Task 01')).not.toBeInTheDocument();
    expect(screen.getByText('11–15 of 15')).toBeInTheDocument();
    expect(taskReads().some((c) => c.query.page?.[0] === '2' && c.query.clientId?.[0] === 'client-1')).toBe(true);
  });

  it('draws no pager when every task fits on one page', async () => {
    serveTasks(makeTasks(4));

    await renderOnTasksTab();

    expect(await screen.findByText('Task 04')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });
});

describe('searching the task list', () => {
  // Red if: the search only filters the ten rows already downloaded.
  it('sends the term to the server and shows the matches from every page', async () => {
    serveTasks(makeTasks(15));

    await renderOnTasksTab();
    await screen.findByText('Task 01');

    await userEvent.type(screen.getByPlaceholderText('Search tasks...'), 'Task 14');

    expect(await screen.findByText('Task 14')).toBeInTheDocument();
    expect(screen.queryByText('Task 01')).not.toBeInTheDocument();
    await waitFor(() => expect(taskReads().some((c) => c.query.search?.[0] === 'Task 14')).toBe(true));
  });
});

describe('editing a task from the client page', () => {
  async function openEdit() {
    serveTasks(makeTasks(2));
    // The roster feeds the modal's assignee picker; the dependency picker looks up other tasks.
    api.getExact('http://localhost:5001/api/users/lawfirm/firm-1/users', []);
    api.get('/tasks/lookup', { items: [], hasMore: false });
    api.put('/tasks/t1', { task: { id: 't1', title: 'Task 01 revised', status: 'open' } });

    await renderOnTasksTab();
    await screen.findByText('Task 01');
    await userEvent.click(screen.getByRole('button', { name: 'Edit Task 01' }));
  }

  // Red if: the tab stops passing an edit handler, so the row has no edit action.
  it('opens the edit modal pre-filled and saves the change', async () => {
    await openEdit();

    const dialog = await screen.findByRole('dialog', { name: 'Edit Task' });
    const title = within(dialog).getByLabelText('Title *');
    expect(title).toHaveValue('Task 01');
    await userEvent.clear(title);
    await userEvent.type(title, 'Task 01 revised');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.callsTo('/tasks/t1').filter((c) => c.method === 'PUT')).toHaveLength(1));
    expect(api.callsTo('/tasks/t1').find((c) => c.method === 'PUT')?.body).toMatchObject({ title: 'Task 01 revised' });
  });

  it('offers no edit action to a member who cannot update tasks', async () => {
    grantBaselineMember(['tasks.create']);
    serveTasks(makeTasks(2));

    await renderOnTasksTab();
    await screen.findByText('Task 01');

    expect(screen.queryByRole('button', { name: 'Edit Task 01' })).not.toBeInTheDocument();
  });
});

describe('filtering the task list by status', () => {
  // Red if: the "All" option counts the ten rows on this page instead of every task.
  it('counts every task in the All option, not the page on screen', async () => {
    serveTasks(makeTasks(15));

    await renderOnTasksTab();
    await screen.findByText('Task 01');

    expect(screen.getByRole('button', { name: /All Tasks \(15\)/ })).toBeInTheDocument();
  });

  // Task 14 is blocked and lives on page two. Red if: the chip filters only the ten rows already
  // downloaded, which hold no blocked task, so the list goes empty.
  it('asks the server for the chosen status and shows matches from every page', async () => {
    serveTasks(makeTasks(15, (i) => (i === 13 ? 'blocked' : 'open')));

    await renderOnTasksTab();
    await screen.findByText('Task 01');

    await userEvent.click(screen.getByRole('button', { name: /All Tasks/ }));
    await userEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Blocked' }));

    expect(await screen.findByText('Task 14')).toBeInTheDocument();
    expect(screen.queryByText('Task 01')).not.toBeInTheDocument();
    expect(taskReads().some((c) => c.query.status?.[0] === 'blocked' && c.query.page?.[0] === '1')).toBe(true);
  });
});

describe('a task list that fails to load', () => {
  // Red if: a failed read renders the empty state, which tells the user the client has no tasks.
  it('says so and loads the tasks on retry', async () => {
    let attempts = 0;
    const all = makeTasks(2);
    api.get('/lawfirms/firm-1/tasks', () => (++attempts === 1
      ? { status: 500, body: { error: 'tasks service unavailable' } }
      : { tasks: all, totalTasks: all.length }));

    await renderOnTasksTab();

    expect(await screen.findByText(/tasks service unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('No tasks found for this client')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Task 01')).toBeInTheDocument();
  });
});

describe('deleting a task from the client page', () => {
  it('refreshes the All count after deleting a task under a status filter', async () => {
    let all = makeTasks(3, (i) => i === 0 ? 'blocked' : 'open');
    api.get('/lawfirms/firm-1/tasks', (call) => {
      const matching = all.filter((task) => !call.query.status?.[0] || task.status === call.query.status[0]);
      return { tasks: matching, totalTasks: matching.length };
    });
    api.delete('/tasks/t1', () => {
      all = all.filter((task) => task.id !== 't1');
      return { message: 'Task deleted' };
    });
    await renderOnTasksTab();
    await screen.findByText('Task 01');
    await userEvent.click(screen.getByRole('button', { name: /All Tasks/ }));
    await userEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Blocked' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Task 01' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Delete Task' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('Task 01')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^Blocked/ }));
    expect(within(await screen.findByRole('listbox')).getByRole('option', { name: 'All Tasks (2)' })).toBeInTheDocument();
  });

  it('returns to the first page after deleting the only task on the final page', async () => {
    const all = makeTasks(11);
    serveTasks(all);
    api.delete('/tasks/t11', () => {
      all.pop();
      return { message: 'Task deleted' };
    });
    await renderOnTasksTab();
    await screen.findByText('Task 01');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Task 11');
    await userEvent.click(screen.getByRole('button', { name: 'Delete Task 11' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Delete Task' })).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Task 01')).toBeInTheDocument();
    expect(screen.queryByText('No tasks found for this client')).not.toBeInTheDocument();
  });

  // Red if: the tab is never handed a delete handler, so the row has no delete action.
  it('confirms, deletes the task and re-reads the list', async () => {
    let all = makeTasks(2);
    api.get('/lawfirms/firm-1/tasks', () => ({ tasks: all, totalTasks: all.length }));
    api.delete('/tasks/t1', () => {
      all = all.filter((t) => t.id !== 't1');
      return { message: 'Task deleted' };
    });

    await renderOnTasksTab();
    await screen.findByText('Task 01');
    await userEvent.click(screen.getByRole('button', { name: 'Delete Task 01' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete Task' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.callsTo('/tasks/t1').filter((c) => c.method === 'DELETE')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('Task 01')).not.toBeInTheDocument());
    expect(screen.getByText('Task 02')).toBeInTheDocument();
  });

  it('offers no delete action to a member who cannot delete tasks', async () => {
    grantBaselineMember(['tasks.update']);
    serveTasks(makeTasks(2));

    await renderOnTasksTab();
    await screen.findByText('Task 01');

    expect(screen.getByRole('button', { name: 'Edit Task 01' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Task 01' })).not.toBeInTheDocument();
  });
});
