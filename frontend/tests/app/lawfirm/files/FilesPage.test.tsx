/**
 * The firm Files page: a single route that is simultaneously a Matters/Tasks/
 * Clients dashboard (reusing the SAME paged-list hooks the real Matters/Tasks/
 * Clients pages use) and a firm-wide/matter/task/client folder browser
 * (`FileBrowser` + `useFileBrowser`), gated on `files.view`.
 *
 * `matters.service`, `files.service`, `practiceArea.service`, `users.service`
 * and `requestDeduplicator` run for real against a faked transport, so a wrong
 * url, a swallowed error, or a stale response reaching a switched firm fails
 * the spec instead of a stubbed hook quietly returning whatever the test
 * handed it.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/files.service');
jest.unmock('@/services/practiceArea.service');
jest.unmock('@/services/users.service');
jest.unmock('@/services/requestDeduplicator');

const useParamsMock = jest.fn();
const useSearchParamsMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/files',
  useParams: () => useParamsMock(),
  useSearchParams: () => useSearchParamsMock(),
}));

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import FilesPage from '@/app/lawfirm/[lawFirmId]/files/page';
import { FirmSettingsProvider } from '@/contexts/FirmSettingsContext';
import { setupApiMock, type RecordedCall } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, grantOutsider, grantPermissions, resetPermissions } from '../../../support/permissions';
import { DEFAULT_PERMISSIONS } from '@/lib/constants/permissions';
import type { Matter } from '@/types';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const FIRM_A = 'firm-a';
const FIRM_B = 'firm-b';
const API = 'http://localhost:5001/api';

const api = setupApiMock();

function mattersUrl(firmId: string): string {
  return `${API}/lawfirms/${firmId}/matters`;
}

/** The grid's opening request: page 1, limit 10, name ascending. */
function defaultListUrl(firmId: string): string {
  return `${mattersUrl(firmId)}?limit=10&page=1&sort=name:asc`;
}

function firmFolderUrl(firmId: string): string {
  return `${API}/lawfirms/${firmId}/files/list-folder`;
}

/** Suffix (no host) for `list-folder`, so a spec can branch on the request's
 *  query (e.g. `folderId`) without pinning the exact query string. */
const LIST_FOLDER_SUFFIX = '/files/list-folder';
const DELETE_FILE_SUFFIX = '/files/delete';

function matter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: 'matter-1',
    name: 'Smith v. Jones',
    status: 'active',
    matterNumber: 'M-1001',
    practiceAreaName: 'Litigation',
    leadUserName: 'Pat Attorney',
    clientNames: ['Jane Smith'],
    clientCount: 1,
    ...overrides,
  } as Matter;
}

/**
 * Every route the page fetches on mount for one law firm's dashboard
 * (default "Matters" tab), with sensible empty defaults: the paged matters
 * list, the practice-area/lead/category filter sources, and firm storage
 * usage (kept low so `StorageUsageBar` renders nothing extra to assert past).
 */
function seedFilesWorkspace(opts: {
  firmId?: string;
  matters?: Matter[];
  totalItems?: number;
  listUrl?: string;
} = {}) {
  const firmId = opts.firmId ?? FIRM_A;
  const rows = opts.matters ?? [];
  api.get(`/lawfirms/${firmId}/tasks`, { tasks: [], totalTasks: 0 });
  api.get(`/lawfirms/${firmId}/clients`, { clients: [], totalItems: 0 });
  api.getExact(opts.listUrl ?? defaultListUrl(firmId), { matters: rows, totalItems: opts.totalItems ?? rows.length });
  api.getExact(`${API}/lawfirms/${firmId}/practice-areas`, { practiceAreas: [] });
  api.getExact(`${API}/users/lawfirm/${firmId}/users`, []);
  api.getExact(`${mattersUrl(firmId)}/categories`, { categories: [] });
  api.getExact(`${API}/lawfirms/${firmId}/files/usage`, {
    usedBytes: 0, limitBytes: 1_000_000_000, fileCount: 0, usedFormatted: '0 B', limitFormatted: '1 GB', percentUsed: 0,
  });
}

function renderFilesPage(firmId: string = FIRM_A) {
  return renderWithProviders(
    <FirmSettingsProvider lawFirmId={firmId} initialSettings={{}}>
      <FilesPage />
    </FirmSettingsProvider>,
  );
}

beforeEach(() => {
  __resetDuplicateRequestGuard();
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A });
  useSearchParamsMock.mockReturnValue(new URLSearchParams());
  // The page mirrors its own view/entity/folder state into real
  // `window.history` entries and seeds its initial state from
  // `window.location.search`; without resetting both, a location written by
  // one spec (e.g. `?view=lawFirm`) leaks into the next spec's initial render.
  window.history.replaceState(null, '', 'http://localhost/lawfirm/firm-a/files');
  window.localStorage.clear();
});

afterEach(() => {
  resetPermissions();
  jest.clearAllMocks();
});

describe('entity list spacing', () => {
  it.each([
    ['Matters', 'Smith v. Jones', 'Name'],
    ['Tasks', 'Draft motion', 'Title'],
    ['Clients', 'Jane Smith', 'Name'],
  ])('groups the %s heading and sort controls with 16px spacing', async (tab, rowName, sortName) => {
    seedFilesWorkspace({ matters: [matter()] });
    api.get(`/lawfirms/${FIRM_A}/tasks`, {
      tasks: [{ id: 'task-1', taskId: 'task-1', title: 'Draft motion', status: 'open' }],
      totalTasks: 1,
    });
    api.get(`/lawfirms/${FIRM_A}/clients`, {
      clients: [{ id: 'client-1', name: 'Jane Smith', status: 'active' }],
      totalItems: 1,
    });
    renderFilesPage();
    await screen.findByText('Smith v. Jones');
    if (tab !== 'Matters') {
      await userEvent.click(screen.getByRole('button', { name: tab }));
    }
    expect(await screen.findByText(rowName)).toBeInTheDocument();
    const heading = screen.getByRole('heading', { name: `${tab} (1)` });
    const section = heading.parentElement!.parentElement!;
    expect(section).toHaveClass('space-y-4');
    expect(section).toContainElement(screen.getByRole('button', { name: sortName }));
    expect(heading.parentElement).not.toHaveClass('mb-4');
    expect(heading.parentElement).not.toHaveClass('min-h-10');
    expect(heading.parentElement).toHaveClass('items-end');
  });
});

describe('loaded content', () => {
  it('shows a real matter row returned by the server on the default Matters tab', async () => {
    seedFilesWorkspace({ matters: [matter()] });

    renderFilesPage();

    expect(await screen.findByText('Smith v. Jones')).toBeInTheDocument();
    expect(screen.getByText('Matters (1)')).toBeInTheDocument();
  });
});

describe('a meaningful empty state', () => {
  it('says no matters found rather than rendering a blank grid', async () => {
    seedFilesWorkspace();

    renderFilesPage();

    expect(await screen.findByText('No matters found')).toBeInTheDocument();
    expect(screen.getByText('Try adjusting your search or filters.')).toBeInTheDocument();
  });
});

describe('an API failure', () => {
  it('keeps the rest of the dashboard usable and recovers once retrying succeeds', async () => {
    seedFilesWorkspace();
    // Registered AFTER the workspace defaults so it wins the match (routes are
    // matched most-recently-registered-first): the first call fails, a retry
    // succeeds.
    let attempt = 0;
    api.getExact(defaultListUrl(FIRM_A), () => {
      attempt += 1;
      if (attempt === 1) return { status: 500, body: { error: 'matters service unavailable' } };
      return { matters: [matter()], totalItems: 1 };
    });

    renderFilesPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/matters service unavailable/i);

    // A failure loading ONE tab's grid must not blank the whole page: the
    // tab switcher (and everything else on the dashboard) has to stay usable
    // so the viewer can navigate away from what's actually broken.
    expect(screen.getByRole('group', { name: 'Browse files by' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Law Firm Files/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(await screen.findByText('Smith v. Jones')).toBeInTheDocument();
  });
});

describe('narrow role behavior', () => {
  it('turns away a caller with no membership at all, and fires no requests', async () => {
    grantOutsider();
    seedFilesWorkspace();

    renderFilesPage();

    expect(
      await screen.findByText('You do not have permission to view files for this law firm.'),
    ).toBeInTheDocument();
    expect(api.calls()).toHaveLength(0);
  });

  it('degrades a read-only member to a view-only grid instead of denying the page', async () => {
    grantBaselineMember(); // files.view only: no files.upload, files.delete, documents.request
    seedFilesWorkspace({ matters: [matter()] });

    renderFilesPage();

    expect(await screen.findByText('Smith v. Jones')).toBeInTheDocument();
    // No per-row delete action for a viewer without files.delete.
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

    // Nor an Upload affordance once a folder is open.
    api.getExact(firmFolderUrl(FIRM_A), { files: [] });
    await userEvent.click(screen.getByRole('button', { name: /Law Firm Files/i }));
    await screen.findByText('No law firm files');
    expect(screen.queryByRole('button', { name: /Upload/i })).not.toBeInTheDocument();
  });
});

describe('a successful action: deleting a file', () => {
  it('removes the file from the Law Firm Files listing once the server confirms the delete', async () => {
    grantBaselineMember(['files.upload', 'files.delete']);
    seedFilesWorkspace();
    const file = {
      id: 'file-privacy', parentId: null,
      name: 'privacy-policy.pdf', objectPath: 'lawfirmids/firm-a/objects/file-privacy', size: 1024,
      contentType: 'application/pdf', updated: '2026-01-01T00:00:00.000Z', signedUrl: 'https://example.test/f',
    };
    let listCall = 0;
    api.getExact(firmFolderUrl(FIRM_A), () => {
      listCall += 1;
      return { files: listCall === 1 ? [file] : [] };
    });
    let deleteCalls = 0;
    api.delete(DELETE_FILE_SUFFIX, () => {
      deleteCalls += 1;
      return { message: 'Deleted successfully' };
    });

    renderFilesPage();
    await userEvent.click(await screen.findByRole('button', { name: /Law Firm Files/i }));

    await screen.findByText('privacy-policy.pdf');
    await userEvent.click(screen.getByLabelText('More actions'));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('privacy-policy.pdf')).not.toBeInTheDocument());
    expect(deleteCalls).toBe(1);
    expect(await screen.findByText('Deleted successfully')).toBeInTheDocument();
  });
});

describe('permission gating: matter/task delete on the entity grids', () => {
  // The Files page's Matters-tab row action calls MattersService.deleteMatter
  // (a full matter delete, not a file delete). It used to be gated on
  // `files.delete`, the wrong permission for this mutation - the real Matters
  // page gates the identical action on `matters.delete` (MattersGrid.tsx). A
  // member with files.delete but not matters.delete could see and click a
  // delete icon here that the backend would still refuse. Fixed to check
  // `matters.delete`, matching MattersGrid.tsx.
  it('hides the matter-delete action from a files.delete-only member (wrong permission, no matters.delete)', async () => {
    grantPermissions([...DEFAULT_PERMISSIONS, 'files.delete']);
    seedFilesWorkspace({ matters: [matter()] });

    renderFilesPage();

    await screen.findByText('Smith v. Jones');
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('shows the matter-delete action, and deletes, for a member with matters.delete', async () => {
    grantPermissions([...DEFAULT_PERMISSIONS, 'matters.delete']);
    seedFilesWorkspace();
    let listCall = 0;
    api.getExact(defaultListUrl(FIRM_A), () => {
      listCall += 1;
      return { matters: listCall === 1 ? [matter()] : [], totalItems: listCall === 1 ? 1 : 0 };
    });
    api.deleteExact(`${mattersUrl(FIRM_A)}/matter-1`, { message: 'Matter deleted successfully' });

    renderFilesPage();

    await screen.findByText('Smith v. Jones');
    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    await userEvent.click(deleteButton);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('Smith v. Jones')).not.toBeInTheDocument());
  });
});

describe('a law firm switch while a request is pending', () => {
  it('never lets a slow response for the old firm land as the new firm\'s matters tab', async () => {
    api.getExact(defaultListUrl(FIRM_A), { matters: [matter({ name: 'Firm A Matter' })], totalItems: 1 });
    api.getExact(`${API}/lawfirms/${FIRM_A}/practice-areas`, { practiceAreas: [] });
    api.getExact(`${API}/users/lawfirm/${FIRM_A}/users`, []);
    api.getExact(`${mattersUrl(FIRM_A)}/categories`, { categories: [] });
    api.getExact(`${API}/lawfirms/${FIRM_A}/files/usage`, { usedBytes: 0, limitBytes: 1, fileCount: 0, usedFormatted: '0', limitFormatted: '1', percentUsed: 0 });

    seedFilesWorkspace({ firmId: FIRM_B, matters: [matter({ id: 'matter-b', name: 'Firm B Matter' })] });
    api.getExact(defaultListUrl(FIRM_B), { delayMs: 200, body: { matters: [matter({ id: 'matter-b', name: 'Firm B Matter' })], totalItems: 1 } });

    const { rerender } = renderFilesPage(FIRM_A);
    await screen.findByText('Firm A Matter');

    // Firm B's slow response is still in flight when the viewer switches firms.
    useParamsMock.mockReturnValue({ lawFirmId: FIRM_B });
    window.history.replaceState(null, '', 'http://localhost/lawfirm/firm-b/files');
    rerender(
      <FirmSettingsProvider lawFirmId={FIRM_B} initialSettings={{}}>
        <FilesPage />
      </FirmSettingsProvider>,
    );

    // Firm A's matter must not keep rendering, attributed to firm B, while
    // firm B's own paged-matters read is still ~200ms from resolving. This is
    // a SYNCHRONOUS check (no `waitFor`): `usePagedMatters`'s pagination
    // `placeholderData` hands the new query firm A's last successful rows the
    // instant the key changes, so a `waitFor` here would still pass once firm
    // B's response lands ~200ms later regardless of what rendered in between.
    expect(screen.queryByText('Firm A Matter')).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('Firm B Matter')).toBeInTheDocument());
    expect(screen.queryByText('Firm A Matter')).not.toBeInTheDocument();
  });
});

describe('a folder navigation while a request is pending', () => {
  it('never lets a slow response for the old folder land as the new folder\'s listing', async () => {
    seedFilesWorkspace();
    api.get(LIST_FOLDER_SUFFIX, (call: RecordedCall) => {
      if (call.query.folderId?.[0] === 'folder-contracts') {
        return {
          delayMs: 200,
          body: {
            files: [{
              id: 'file-nda', parentId: 'folder-contracts', name: 'nda.pdf',
              objectPath: 'lawfirmids/firm-a/objects/file-nda', size: 10,
              contentType: 'application/pdf', updated: '2026-01-01T00:00:00.000Z',
              signedUrl: 'https://example.test/nda',
            }],
          },
        };
      }
      return {
        files: [{
          id: 'folder-contracts', parentId: null, name: 'Contracts', objectPath: '',
          size: 0, contentType: 'folder', updated: '2026-01-01T00:00:00.000Z',
          signedUrl: '', isFolder: true,
        }],
      };
    });

    renderFilesPage();
    await userEvent.click(await screen.findByRole('button', { name: /Law Firm Files/i }));
    await screen.findByText('Contracts');

    // Opening the Contracts folder starts a slow request; the root's listing
    // (which only ever had the "Contracts" folder row, not a file) must not
    // linger as though it were already Contracts' own contents - the browser
    // shows its loading state instead of stale rows from the folder just left.
    await userEvent.click(screen.getByText('Contracts'));
    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('nda.pdf')).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('nda.pdf')).toBeInTheDocument());
  });
});

describe('browser history after a Back/Forward or an incoming folder link', () => {
  // The page writes its own history entries, and holds pushes off while a
  // Back/Forward or an incoming link settles. That hold is released when the
  // page reaches the location it was restoring to. If the two sides describe a
  // location differently, the hold never releases and every later move stops
  // reaching the URL and the Back stack.
  //
  // Goes red if the restore target and the location the sync effect observes
  // are serialized with different fields, or if a link to a folder that no
  // longer resolves leaves the hold waiting for a folder that never opens.

  function folderRow(id: string, name: string, parentId: string | null) {
    return {
      id, parentId, name, objectPath: '', size: 0, contentType: 'folder',
      updated: '2026-01-01T00:00:00.000Z', signedUrl: '', isFolder: true,
    };
  }

  /** Root holds Contracts, Contracts holds Drafts, Drafts is empty. */
  function seedFolderTree() {
    api.get(LIST_FOLDER_SUFFIX, (call: RecordedCall) => {
      const folderId = call.query.folderId?.[0];
      if (folderId === 'folder-contracts') return { files: [folderRow('folder-drafts', 'Drafts', 'folder-contracts')] };
      if (folderId === 'folder-drafts') return { files: [] };
      return { files: [folderRow('folder-contracts', 'Contracts', null)] };
    });
  }

  function urlFolderId(): string | null {
    return new URL(window.location.href).searchParams.get('folderId');
  }

  it('keeps pushing history for folders opened after pressing Back', async () => {
    seedFilesWorkspace();
    seedFolderTree();

    renderFilesPage();
    await userEvent.click(await screen.findByRole('button', { name: /Law Firm Files/i }));
    await userEvent.click(await screen.findByText('Contracts'));
    await screen.findByText('Drafts');
    expect(urlFolderId()).toBe('folder-contracts');

    window.history.back();
    await waitFor(() => expect(urlFolderId()).toBeNull());
    await screen.findByText('Contracts');

    const lengthBefore = window.history.length;
    await userEvent.click(screen.getByText('Contracts'));
    await screen.findByText('Drafts');

    await waitFor(() => expect(urlFolderId()).toBe('folder-contracts'));
    expect(window.history.length).toBe(lengthBefore);
    // The move replaced the forward entry rather than being dropped: Back
    // returns to the root again.
    window.history.back();
    await waitFor(() => expect(urlFolderId()).toBeNull());
  });

  it('updates the URL for a folder opened after arriving on a ?folderId= link', async () => {
    const search = 'view=lawFirm&folderId=folder-contracts';
    window.history.replaceState(null, '', `http://localhost/lawfirm/firm-a/files?${search}`);
    useSearchParamsMock.mockReturnValue(new URLSearchParams(search));
    seedFilesWorkspace();
    seedFolderTree();
    api.get('/files/location', {
      scope: 'firm', matterId: null, taskId: null, clientId: null, name: 'Contracts', trail: [],
    });

    renderFilesPage();
    await screen.findByText('Drafts');
    // Once the linked folder has opened, the entry for it names it.
    await waitFor(() => expect(urlFolderId()).toBe('folder-contracts'));

    await userEvent.click(screen.getByText('Drafts'));
    await screen.findByText('Empty folder');
    await waitFor(() => expect(urlFolderId()).toBe('folder-drafts'));

    // Back from the sub-folder returns to the folder the link opened.
    window.history.back();
    await waitFor(() => expect(urlFolderId()).toBe('folder-contracts'));
    expect(await screen.findByText('Drafts')).toBeInTheDocument();
  });

  it('keeps updating the URL after a ?folderId= link to a folder that no longer resolves', async () => {
    const search = 'view=lawFirm&folderId=folder-gone';
    window.history.replaceState(null, '', `http://localhost/lawfirm/firm-a/files?${search}`);
    useSearchParamsMock.mockReturnValue(new URLSearchParams(search));
    seedFilesWorkspace();
    seedFolderTree();
    api.get('/files/location', { status: 404, body: { error: 'File not found' } });

    renderFilesPage();
    await waitFor(() => expect(api.calls('GET').some((c) => c.pathname.endsWith('/files/location'))).toBe(true));
    await screen.findByText('Contracts');

    await userEvent.click(screen.getByText('Contracts'));
    await screen.findByText('Drafts');
    await waitFor(() => expect(urlFolderId()).toBe('folder-contracts'));
  });
});
