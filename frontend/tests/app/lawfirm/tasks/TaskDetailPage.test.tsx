/**
 * The task detail page: the overview tab, the tab strip, and the single-task
 * delete flow, driven through the REAL tasks service against a faked
 * transport.
 *
 * Like the matter detail page (fixed earlier in this pass), this page manages
 * its own task/matter/clients state with plain `useState` + `useEffect`
 * instead of React Query, so it gets none of React Query's automatic
 * per-key staleness protection. That makes the "context change while a
 * request is pending" case (switching from one task to another while the
 * first is still loading) the one most likely to have its own bug.
 */
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/users.service');
jest.unmock('@/services/matters.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

// The Notes tab pulls in `isomorphic-dompurify`, whose server-side (jsdom)
// branch requires the real `jsdom` package - which drags in an ESM-only
// dependency Jest's transform can't parse. Swap in the plain browser
// `dompurify` package, matching `tests/components/notes/NotesSection.test.tsx`.
jest.mock('isomorphic-dompurify', () => require('dompurify'));

// Record what the page asks the charge-code hook for, while keeping its real
// behaviour, so a spec can see whether the closed time-entry modal's codes
// were requested.
const mockUseChargeCodesArgs = jest.fn();
jest.mock('@/hooks/chargeCodeHooks/useChargeCodes', () => {
  const actual = jest.requireActual('@/hooks/chargeCodeHooks/useChargeCodes');
  return {
    __esModule: true,
    default: (...args: unknown[]) => {
      mockUseChargeCodesArgs(...args);
      return actual.default(...args);
    },
  };
});

const mockRouterPush = jest.fn();
const useParamsMock = jest.fn();
// The query string the page was opened with; a spec sets it for a deep link.
let mockSearch = '';
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/tasks/task-1',
  useParams: () => useParamsMock(),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

// Record what the header's Start Timer hands the running-timer context.
const mockStartTimer = jest.fn();
jest.mock('@/contexts/BillingTimerContext', () => ({
  __esModule: true,
  ...jest.requireActual('@/contexts/BillingTimerContext'),
  useBillingTimer: () => ({ startTimer: mockStartTimer }),
}));

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigate: () => ({ navigate: mockNavigate, isNavigating: false }),
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ViewTaskPage from '@/app/lawfirm/[lawFirmId]/tasks/[taskId]/page';
import { setupApiMock } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, resetPermissions } from '../../../support/permissions';
import type { Matter, Task } from '@/types';

const FIRM_A = 'firm-a';
const TASK_1 = 'task-1';
const TASK_2 = 'task-2';
const API = 'http://localhost:5001/api';

const api = setupApiMock();

function taskUrl(taskId: string, firmId: string = FIRM_A): string {
  return `${API}/lawfirms/${firmId}/tasks/${taskId}`;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_1,
    taskId: TASK_1,
    lawFirmId: FIRM_A,
    title: 'File motion',
    status: 'open',
    priority: 'medium',
    totalNotes: 0,
    ...overrides,
  } as Task;
}

/** The firm-users read the page fires unconditionally on mount, regardless of the task read's outcome. */
function seedIncidentalReads(firmId: string) {
  api.getExact(`${API}/users/lawfirm/${firmId}/users`, []);
}

/**
 * Every route the detail page fetches on mount for a given task, regardless
 * of tab: the task itself, plus the always-mounted subtasks section.
 *
 * The `tz` query param on the task read varies with the test host's
 * timezone, so it's matched by suffix rather than an exact url.
 */
function seedTaskWorkspace(opts: { firmId?: string; taskId?: string; task?: Task } = {}) {
  const firmId = opts.firmId ?? FIRM_A;
  const taskId = opts.taskId ?? TASK_1;
  api.get(`/tasks/${taskId}`, opts.task ?? task({ id: taskId, taskId }));
  api.get(`/tasks/${taskId}/subtasks`, { subtasks: [] });
  seedIncidentalReads(firmId);
}

/** Seeds the matter + matter-clients reads a matter-linked task fires. */
function seedMatterWorkspace(matterId: string, firmId: string = FIRM_A, matter: Partial<Matter> = {}) {
  api.getExact(`${API}/lawfirms/${firmId}/matters/${matterId}`, {
    id: matterId,
    name: 'Smith v. Jones',
    status: 'active',
    ...matter,
  });
  api.getExact(`${API}/lawfirms/${firmId}/matters/${matterId}/clients`, { clients: [] });
  // The always-mounted (but closed) "Add Time" modal resolves its preset
  // matter target through the matters lookup endpoint, matching
  // `MatterDetailPage.test.tsx`'s same note about its own "Add Hours" modal.
  api.get('/matters/lookup', { items: [], hasMore: false });
}

function renderTaskPage() {
  return renderWithProviders(<ViewTaskPage />);
}

it.each([false, true])('requires client management for task client controls (grant: %s)', async (canManage) => {
  grantBaselineMember(['tasks.update', ...(canManage ? ['clients.manage'] : [])]);
  seedTaskWorkspace();
  renderTaskPage();
  await screen.findByText('File motion');
  await userEvent.click(screen.getByRole('button', { name: /^Clients/ }));
  if (canManage) expect(screen.getByRole('button', { name: 'Add Client' })).toBeInTheDocument();
  else expect(screen.queryByRole('button', { name: 'Add Client' })).not.toBeInTheDocument();
});

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A, taskId: TASK_1 });
});

afterEach(() => {
  resetPermissions();
  jest.clearAllMocks();
  mockSearch = '';
});

describe('loaded content', () => {
  it('shows the real task information', async () => {
    seedTaskWorkspace({ task: task({ title: 'File motion', priority: 'high', status: 'in_progress' }) });

    renderTaskPage();

    expect(await screen.findByRole('heading', { name: /File motion/ })).toBeInTheDocument();
    // "In Progress" appears twice by design: the header's status badge and the
    // header's own status-change control both name the current status.
    expect(screen.getAllByText('In Progress').length).toBeGreaterThan(0);
    expect(screen.getByText('High')).toBeInTheDocument();
  });
});

describe('a meaningful empty state', () => {
  it('says the task is not linked to a matter, rather than leaving the panel blank', async () => {
    seedTaskWorkspace({ task: task({ matterId: undefined }) });

    renderTaskPage();

    await screen.findByRole('heading', { name: /File motion/ });
    expect(screen.getByText('Not linked to a matter')).toBeInTheDocument();
    expect(screen.getByText('This task is not associated with any matter.')).toBeInTheDocument();
  });
});

describe('an API failure, with retry', () => {
  it('shows the real error rather than a blank page', async () => {
    seedIncidentalReads(FIRM_A);
    api.get(`/tasks/${TASK_1}`, { status: 500, body: { error: 'tasks service unavailable' } });

    renderTaskPage();

    expect(await screen.findByText(/tasks service unavailable/i)).toBeInTheDocument();
  });

  it('offers a way back to the tasks list', async () => {
    seedIncidentalReads(FIRM_A);
    api.get(`/tasks/${TASK_1}`, { status: 500, body: { error: 'tasks service unavailable' } });

    renderTaskPage();

    await screen.findByText(/tasks service unavailable/i);
    expect(screen.getByRole('button', { name: /Back to Tasks/i })).toBeInTheDocument();
  });
});

describe('narrow role behavior', () => {
  it('shows a baseline member the task read-only, with no edit or delete controls', async () => {
    grantBaselineMember();
    seedTaskWorkspace();

    renderTaskPage();

    expect(await screen.findByRole('heading', { name: /File motion/ })).toBeInTheDocument();
    // tasks.view is baseline; tasks.update/tasks.delete are not.
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});

describe('a successful action: deleting the task', () => {
  it('deletes the task and returns to the tasks list', async () => {
    seedTaskWorkspace();
    api.deleteExact(taskUrl(TASK_1), { message: 'Task deleted' });

    renderTaskPage();

    await screen.findByRole('heading', { name: /File motion/ });
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/File motion/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(`/lawfirm/${FIRM_A}/tasks`));
    expect(api.callsTo(`/tasks/${TASK_1}`).filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
});

describe('a refused action: the delete fails', () => {
  it('tells the user the task was not deleted, and stays on the page', async () => {
    seedTaskWorkspace();
    api.deleteExact(taskUrl(TASK_1), {
      status: 409, body: { error: 'This task has dependent tasks and cannot be deleted' },
    });

    renderTaskPage();

    await screen.findByRole('heading', { name: /File motion/ });
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/dependent tasks and cannot be deleted/i)).toBeInTheDocument();
    expect(mockRouterPush).not.toHaveBeenCalled();
    // Still showing the task - the delete never actually happened.
    expect(screen.getByRole('heading', { name: /File motion/ })).toBeInTheDocument();
  });
});

describe('a task switch while a request is pending', () => {
  it('never lets a slow response for the old task land as the new task\'s detail', async () => {
    seedTaskWorkspace({ taskId: TASK_1 });
    seedTaskWorkspace({ taskId: TASK_2, task: task({ id: TASK_2, taskId: TASK_2, title: 'New Fast Task' }) });
    // Registered LAST so it wins over the plain route `seedTaskWorkspace`
    // just set up for the same url (later registrations take precedence).
    api.get(`/tasks/${TASK_1}`, { delayMs: 200, body: task({ id: TASK_1, taskId: TASK_1, title: 'Old Slow Task' }) });

    const { rerender } = renderTaskPage();

    // Task 1's slow response is still in flight when the viewer navigates to
    // task 2 (e.g. via browser back/forward, without a full page remount).
    useParamsMock.mockReturnValue({ lawFirmId: FIRM_A, taskId: TASK_2 });
    rerender(<ViewTaskPage />);

    expect(await screen.findByRole('heading', { name: /New Fast Task/ })).toBeInTheDocument();

    // Even once task 1's slow response finally arrives, it must not
    // overwrite the page now showing task 2.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByRole('heading', { name: /New Fast Task/ })).toBeInTheDocument();
    expect(screen.queryByText('Old Slow Task')).not.toBeInTheDocument();
  });
});

describe('a task switch from a matter-linked task to a matter-less one', () => {
  it('drops the old task\'s matter panel instead of leaving it on screen for the new task', async () => {
    const MATTER_1 = 'matter-1';
    seedTaskWorkspace({ taskId: TASK_1, task: task({ id: TASK_1, taskId: TASK_1, matterId: MATTER_1 }) });
    seedMatterWorkspace(MATTER_1);
    seedTaskWorkspace({
      taskId: TASK_2,
      task: task({ id: TASK_2, taskId: TASK_2, title: 'Standalone Task', matterId: undefined }),
    });

    const { rerender } = renderTaskPage();

    await screen.findByRole('heading', { name: /File motion/ });
    // The related-matter panel shows the real matter while task 1 is open.
    expect(await screen.findByText('Smith v. Jones')).toBeInTheDocument();

    // Same page instance, navigated to a task with no matter (e.g. via the
    // Dependencies list, which links to another task on this same route).
    useParamsMock.mockReturnValue({ lawFirmId: FIRM_A, taskId: TASK_2 });
    rerender(<ViewTaskPage />);

    expect(await screen.findByRole('heading', { name: /Standalone Task/ })).toBeInTheDocument();
    expect(screen.getByText('Not linked to a matter')).toBeInTheDocument();
    expect(screen.queryByText('Smith v. Jones')).not.toBeInTheDocument();
  });
});

describe('first load', () => {
  it('holds back charge codes, which only the closed time-entry modal uses', async () => {
    seedTaskWorkspace();

    renderTaskPage();
    await screen.findByRole('heading', { name: /File motion/ });

    expect(mockUseChargeCodesArgs).toHaveBeenCalled();
    expect(mockUseChargeCodesArgs.mock.calls.every((call) => call[2] === false)).toBe(true);
  });
});


describe('the status control', () => {
  // Red if: the hand-built menu comes back, which listed only the OTHER statuses in its own order
  // and painted its own dot colours instead of the shared status vocabulary.
  it('lists every status in the shared order and saves the one chosen', async () => {
    seedTaskWorkspace({ task: task({ status: 'open' }) });
    api.put(`/tasks/${TASK_1}`, { task: task({ status: 'completed' }) });

    renderTaskPage();
    await screen.findByRole('heading', { name: /File motion/ });

    await userEvent.click(screen.getByRole('button', { name: 'Change status' }));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Open',
      'In Progress',
      'Blocked',
      'Completed',
    ]);

    await userEvent.click(within(listbox).getByRole('option', { name: 'Completed' }));

    await waitFor(() => expect(api.callsTo(`/tasks/${TASK_1}`).filter((c) => c.method === 'PUT')).toHaveLength(1));
    expect(api.callsTo(`/tasks/${TASK_1}`).find((c) => c.method === 'PUT')?.body).toMatchObject({ status: 'completed' });
  });

  it('is not offered to a member who cannot update tasks', async () => {
    grantBaselineMember();
    seedTaskWorkspace();

    renderTaskPage();
    await screen.findByRole('heading', { name: /File motion/ });

    expect(screen.queryByRole('button', { name: 'Change status' })).not.toBeInTheDocument();
  });
});

describe('the header time actions', () => {
  it('offers Log Time and Start Timer to a member who can manage time entries', async () => {
    seedTaskWorkspace();

    renderTaskPage();
    await screen.findByRole('heading', { name: /File motion/ });

    expect(screen.getByRole('button', { name: 'Log Time' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Timer' })).toBeInTheDocument();
  });

  it('hides them from a member who can update tasks but not manage time entries', async () => {
    grantBaselineMember(['tasks.update']);
    seedTaskWorkspace();

    renderTaskPage();
    await screen.findByRole('heading', { name: /File motion/ });

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log Time' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Timer' })).not.toBeInTheDocument();
  });
});


describe('retracting a note on a task', () => {
  const MATTER_1 = 'matter-1';
  const NOTE = {
    id: 'note-1', subject: 'Called the clerk', content: 'Body', contentHtml: '<p>Body</p>', noteType: 'general',
    createdBy: 'test-uid', createdByName: 'Test User', createdAt: '2026-02-01T10:00:00.000Z', noteDate: '2026-02-01',
    parentType: 'task', parentId: 'task-1', lawFirmId: 'firm-1',
  };

  async function openNotes() {
    seedTaskWorkspace({ task: task({ matterId: MATTER_1 }) });
    seedMatterWorkspace(MATTER_1);
    api.get('/notes', { notes: [NOTE], totalNotes: 1, counts: { all: 1, withTime: 0, withoutTime: 1 }, tags: [] });
    api.get('/note-types', { noteTypes: [] });
    api.get('/note-templates', { noteTemplates: [] });
    renderTaskPage();
    await screen.findByRole('heading', { name: /File motion/ });
    await userEvent.click(screen.getByRole('button', { name: /^Notes/ }));
    await screen.findByText('Called the clerk');
  }

  // The backend requires tasks.update to retract (the parent's write permission), not tasks.delete.
  // Red if: the control follows tasks.delete again, so an editor never sees it and a deleter who cannot
  // update sees one the server refuses.
  it('offers Retract to a member who can update tasks but not delete them', async () => {
    grantBaselineMember(['tasks.update']);
    await openNotes();

    expect(screen.getByRole('button', { name: 'Retract' })).toBeInTheDocument();
  });

  it('offers no Retract to a member who can delete tasks but not update them', async () => {
    grantBaselineMember(['tasks.delete']);
    await openNotes();

    expect(screen.queryByRole('button', { name: 'Retract' })).not.toBeInTheDocument();
  });
});

describe('notes on a task', () => {
  const MATTER_1 = 'matter-1';

  async function openComposerWithSubject(subject: string) {
    seedTaskWorkspace({ task: task({ matterId: MATTER_1 }) });
    seedMatterWorkspace(MATTER_1);
    api.get('/notes', { notes: [], totalNotes: 0, counts: { all: 0, withTime: 0, withoutTime: 0 }, tags: [] });
    api.get('/note-types', { noteTypes: [] });
    api.get('/note-templates', { noteTemplates: [] });

    renderTaskPage();
    await screen.findByRole('heading', { name: /File motion/ });
    await userEvent.click(screen.getByRole('button', { name: /^Notes/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Add Note/i }));
    // The rich-text control is not typeable under jsdom; a template is what fills the editor.
    await userEvent.click(await screen.findByRole('button', { name: /Blank Note/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Phone Call' }));
    await userEvent.type(screen.getByPlaceholderText(/Brief title for this note/i), subject);
  }

  // Red if: the page's add-note handler stops returning the service result, so the panel has no
  // note id to open the time modal against.
  it('opens the time modal for the note just saved by Save & Add Time', async () => {
    api.post('/notes', { status: 201, body: { note: { id: 'note-new' } } });

    await openComposerWithSubject('Called opposing counsel');
    await userEvent.click(screen.getByRole('button', { name: 'More save options' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save & Add Time' }));

    expect(await screen.findByRole('dialog', { name: 'Add Time Entry' })).toBeInTheDocument();
  });

  it('keeps the draft and says why when the save is refused', async () => {
    api.post('/notes', { status: 403, body: { error: 'You cannot add notes to this task' } });

    await openComposerWithSubject('Called opposing counsel');
    await userEvent.click(screen.getByRole('button', { name: 'More save options' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save & Add Time' }));

    expect((await screen.findAllByText(/You cannot add notes to this task/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog', { name: 'Add Time Entry' })).not.toBeInTheDocument();
  });

  // Note time is billing work: the backend requires billing.manageTimeEntries on top of the task
  // write permission. Red if: the control is offered on tasks.update alone.
  it('offers no time controls to a member who can update tasks but not manage time entries', async () => {
    grantBaselineMember(['tasks.update']);

    await openComposerWithSubject('Called opposing counsel');

    expect(screen.getByRole('button', { name: /Save Note/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More save options' })).not.toBeInTheDocument();
  });

  it('offers the time controls once the member can also manage time entries', async () => {
    grantBaselineMember(['tasks.update', 'billing.manageTimeEntries']);

    await openComposerWithSubject('Called opposing counsel');

    expect(screen.getByRole('button', { name: 'More save options' })).toBeInTheDocument();
  });
});

describe('removing an organization from a task', () => {
  const ORG = { id: 'org-1', label: 'Org Co', sublabel: '', name: 'Org Co', clientType: 'company' };
  const PERSON = { id: 'p-1', label: 'Pat Roster', sublabel: '', name: 'Pat Roster', clientType: 'person', organization: 'Org Co' };

  // Organizations are removed on their own, on tasks as on matters. Red if: the page goes back to
  // quietly removing the organization's roster people with it.
  it('removes only the organization and keeps the roster people attached', async () => {
    seedTaskWorkspace({ task: task({ matterId: undefined, clientIds: ['org-1', 'p-1'], clientNames: ['Org Co', 'Pat Roster'] }) });
    api.get('/clients/lookup', { items: [ORG, PERSON], hasMore: false });
    api.get('/clients/org-1/contacts', { contacts: [{ id: 'ct-1', personClientId: 'p-1', name: 'Pat Roster' }] });
    api.get('/clients/org-1', { client: { id: 'org-1', name: 'Org Co', clientType: 'company' } });
    api.put(`/tasks/${TASK_1}`, { task: task({ clientIds: ['p-1'] }) });

    renderTaskPage();
    await screen.findByRole('heading', { name: /File motion/ });
    await userEvent.click(screen.getByRole('button', { name: /^Clients/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Org Co' }));

    const dialog = await screen.findByRole('dialog', { name: 'Remove Client' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(api.callsTo(`/tasks/${TASK_1}`).filter((c) => c.method === 'PUT')).toHaveLength(1));
    expect(api.callsTo(`/tasks/${TASK_1}`).find((c) => c.method === 'PUT')?.body).toMatchObject({ clientIds: ['p-1'] });
  });
});

it('retries an initial task load without leaving the detail page', async () => {
  seedTaskWorkspace();
  let attempts = 0;
  api.get(`/tasks/${TASK_1}`, () => ++attempts === 1
    ? { status: 500, body: { error: 'tasks service unavailable' } }
    : task());
  renderTaskPage();
  await screen.findByRole('alert');
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(attempts).toBe(2));
  await waitFor(() => expect(screen.queryByText('Task not found')).not.toBeInTheDocument());
  expect(screen.getAllByText(task().title).length).toBeGreaterThan(0);
});

describe('starting a timer from the header', () => {
  // Time bills to one matter or one client. Red if: the page goes back to timing a
  // matter-less, multi-client task against its first client, a target the user never chose.
  it('starts nothing on a task with no matter and two clients, and points to Log Time instead', async () => {
    seedTaskWorkspace({
      task: task({ matterId: undefined, clientIds: ['client-a', 'client-b'], clientNames: ['Ada Client', 'Bo Client'] }),
    });
    api.get('/clients/lookup', { items: [], hasMore: false });

    renderTaskPage();
    await screen.findByRole('heading', { name: /File motion/ });

    const start = screen.getByRole('button', { name: 'Start Timer' });
    expect(start).toBeDisabled();
    await userEvent.click(start);
    expect(mockStartTimer).not.toHaveBeenCalled();

    await userEvent.hover(start.parentElement as HTMLElement);
    expect(await screen.findByText(/Use Log time to pick one/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log Time' })).toBeEnabled();
  });

  // Red if: the timer stops billing to the task's matter, or is labelled with the task title
  // where the tasks grid names the matter.
  it('starts a timer on the task\'s matter, labelled with the matter', async () => {
    const MATTER_1 = 'matter-1';
    seedTaskWorkspace({ task: task({ matterId: MATTER_1, matterName: 'Smith v. Jones', clientIds: ['client-a'] }) });
    seedMatterWorkspace(MATTER_1);
    api.get('/clients/lookup', { items: [], hasMore: false });

    renderTaskPage();
    await screen.findByRole('heading', { name: /File motion/ });
    await userEvent.click(screen.getByRole('button', { name: 'Start Timer' }));

    expect(mockStartTimer).toHaveBeenCalledTimes(1);
    expect(mockStartTimer).toHaveBeenCalledWith(expect.objectContaining({
      matterId: MATTER_1,
      clientId: null,
      targetLabel: 'Smith v. Jones',
      sourceTaskId: TASK_1,
    }));
  });

  it('starts a timer on the only client of a matter-less task, labelled with that client', async () => {
    seedTaskWorkspace({ task: task({ matterId: undefined, clientIds: ['client-a'], clientNames: ['Ada Client'] }) });
    api.get('/clients/lookup', { items: [], hasMore: false });

    renderTaskPage();
    await screen.findByRole('heading', { name: /File motion/ });
    await userEvent.click(screen.getByRole('button', { name: 'Start Timer' }));

    expect(mockStartTimer).toHaveBeenCalledWith(expect.objectContaining({
      matterId: null,
      clientId: 'client-a',
      targetLabel: 'Ada Client',
    }));
  });
});

describe('a deep link to a tab', () => {
  it('opens a note link when the task page is already mounted', async () => {
    seedTaskWorkspace();
    api.get('/notes', { notes: [], totalNotes: 0, counts: { all: 0, withTime: 0, withoutTime: 0 }, tags: [] });
    api.get('/note-types', { noteTypes: [] });
    api.get('/note-templates', { noteTemplates: [] });
    const { rerender } = renderTaskPage();
    await screen.findByRole('heading', { name: /File motion/ });
    expect(screen.getByRole('button', { name: /^Overview/ })).toHaveAttribute('aria-current', 'true');

    mockSearch = 'tab=notes&note=note-1';
    rerender(<ViewTaskPage />);
    expect(screen.getByRole('button', { name: /^Notes/ })).toHaveAttribute('aria-current', 'true');
    await waitFor(() => expect(api.callsTo('/notes').length).toBeGreaterThan(0));
  });

  // A copied note link is /tasks/:id?tab=notes&note=:noteId. Red if: the page ignores ?tab=
  // and always opens on the Overview, so the linked note is never on screen.
  it('opens the Notes tab named by ?tab=notes', async () => {
    mockSearch = 'tab=notes&note=note-1';
    seedTaskWorkspace();
    api.get('/notes', { notes: [], totalNotes: 0, counts: { all: 0, withTime: 0, withoutTime: 0 }, tags: [] });
    api.get('/note-types', { noteTypes: [] });
    api.get('/note-templates', { noteTemplates: [] });

    renderTaskPage();
    await screen.findByRole('heading', { name: /File motion/ });

    expect(screen.getByRole('button', { name: /^Notes/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByText('Not linked to a matter')).not.toBeInTheDocument();
    await waitFor(() => expect(api.callsTo('/notes').length).toBeGreaterThan(0));
  });

  it('falls back to the Overview for a tab the page does not have', async () => {
    mockSearch = 'tab=billing';
    seedTaskWorkspace({ task: task({ matterId: undefined }) });

    renderTaskPage();
    await screen.findByRole('heading', { name: /File motion/ });

    expect(screen.getByText('Not linked to a matter')).toBeInTheDocument();
  });
});
