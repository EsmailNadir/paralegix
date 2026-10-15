/**
 * `ClientFilesTab` opens on the client's own files, with each matter and each
 * standalone task holding files listed as a folder at the root, badged with
 * which it is. Opening one moves the browser into it, and the breadcrumb leads
 * back. `previewMode` swaps the browser for the portal preview.
 *
 * What has to break for these to go red: the tab opening anywhere but the
 * client's own files, a matter or task folder not moving the browser into it or
 * the way back not returning, a folder losing its badge, number, count or
 * linked-company reason, a pending reveal landing in the wrong area, preview mode
 * not replacing the browser, a matter's or task's share recipients not being
 * resolved from it, or a failed task read taking the client's files down with it.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/files.service');
jest.unmock('@/services/requestDeduplicator');

// The browser and the portal preview each fetch and render a great deal of
// their own (FileBrowserLinkedFolders.test.tsx covers how the browser draws
// linked folders and the parent crumb). What this tab decides is which one to
// mount and with what props, so the stand-in exposes the folders and the way
// back as plain buttons.
type Folder = { id: string; name: string; subtitle: string; badge?: React.ReactNode; onOpen: () => void };
const mockFilesSection = jest.fn();
jest.mock('@/components/filesComp/FilesSection', () => ({
  __esModule: true,
  default: (props: {
    rootLabel: string;
    rootFolders?: Folder[];
    parentCrumb?: { label: string; onOpen: () => void };
  }) => {
    mockFilesSection(props);
    return (
      <div data-testid="files-section">
        {props.parentCrumb && <button onClick={props.parentCrumb.onOpen}>{props.parentCrumb.label}</button>}
        <span>{props.rootLabel}</span>
        {props.rootFolders?.map((folder) => (
          <button key={folder.id} onClick={folder.onOpen}>
            {`${folder.name} (${folder.subtitle}) `}
            {folder.badge}
          </button>
        ))}
      </div>
    );
  },
}));
jest.mock('@/components/filesComp/ClientPortalFilePreview', () => ({
  __esModule: true,
  default: () => <div data-testid="portal-preview" />,
}));

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { sequence, type MockResponse } from '../../support/apiMock';
import ClientFilesTab from '@/components/clientComp/ClientFilesTab';
import type { FileInfo } from '@/services/files.service';
import type { Matter } from '@/types/matter';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

const MATTERS = [
  { id: 'matter-1', name: 'Smith v. Jones', matterNumber: '2024-001', clients: [{ id: 'client-1' }] },
  { id: 'matter-2', name: 'Acme Lease', matterNumber: null, clients: [{ id: 'company-9' }] },
] as unknown as Matter[];

const FILES = new Map<string, FileInfo[]>([
  ['matter-1', [{ id: 'f1' }, { id: 'f2' }] as unknown as FileInfo[]],
  ['matter-2', [{ id: 'f3' }] as unknown as FileInfo[]],
]);

let api: ApiMock;

beforeEach(() => {
  mockFilesSection.mockClear();
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

const TASKS = [{ id: 'task-1', title: 'Intake paperwork', fileCount: 3 }];

/** Renders the tab and waits for it to settle on its browser. */
async function renderTab(
  overrides: Partial<React.ComponentProps<typeof ClientFilesTab>> = {},
  tasks: MockResponse | { tasks: unknown[] } = { tasks: TASKS },
) {
  api.get('/lawfirms/firm-1/files/list-client-tasks', tasks);
  const onFilesChanged = jest.fn();
  renderWithProviders(
    <ClientFilesTab
      previewMode={false}
      clientId="client-1"
      clientName="Jane Smith"
      clientUserId="user-1"
      clientFiles={FILES}
      clientMatters={MATTERS}
      truncated={false}
      loading={false}
      lawFirmId="firm-1"
      onFilesChanged={onFilesChanged}
      companyNames={new Map([['company-9', 'Acme Corp']])}
      {...overrides}
    />
  );
  await screen.findByTestId('files-section');
  return { onFilesChanged };
}

function lastBrowserProps() {
  return mockFilesSection.mock.calls[mockFilesSection.mock.calls.length - 1][0];
}

describe('ClientFilesTab', () => {
  it("opens on the client's own files, shared with that client alone", async () => {
    await renderTab();

    expect(screen.getAllByTestId('files-section')).toHaveLength(1);
    expect(lastBrowserProps()).toMatchObject({
      clientId: 'client-1',
      rootLabel: 'Client Files',
      shareClients: [{ id: 'client-1', name: 'Jane Smith', userId: 'user-1' }],
    });
    expect(lastBrowserProps().matterId).toBeUndefined();
    expect(lastBrowserProps().parentCrumb).toBeUndefined();
  });

  it("lists each matter as a badged folder with its number, file count and linked company, and opening one moves the browser into it", async () => {
    api.get('/lawfirms/firm-1/matters/matter-1/clients', {
      clients: [
        { id: 'client-1', name: 'Jane Smith', userId: 'user-1' },
        { id: 'client-2', name: 'John Smith', userId: null },
      ],
    });
    const { onFilesChanged } = await renderTab();

    expect(screen.getByRole('button', { name: 'Acme Lease (1 file · via Acme Corp) Matter' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Smith v. Jones (#2024-001 · 2 files) Matter' }));

    await waitFor(() => expect(lastBrowserProps()).toMatchObject({ matterId: 'matter-1', rootLabel: 'Smith v. Jones' }));
    expect(lastBrowserProps().clientId).toBeUndefined();
    expect(lastBrowserProps().rootFolders).toBeUndefined();
    // Leaving the client's area re-reads the per-matter counts.
    expect(onFilesChanged).toHaveBeenCalledTimes(1);
    // A share made in here names every client on the matter, not just this one.
    await waitFor(() =>
      expect(lastBrowserProps().shareClients).toEqual([
        { id: 'client-1', name: 'Jane Smith', userId: 'user-1' },
        { id: 'client-2', name: 'John Smith', userId: null },
      ])
    );
  });

  it("leads back from a matter to the client's own files", async () => {
    api.get('/lawfirms/firm-1/matters/matter-2/clients', { clients: [] });
    const { onFilesChanged } = await renderTab();

    fireEvent.click(screen.getByRole('button', { name: /^Acme Lease/ }));
    await waitFor(() => expect(lastBrowserProps().matterId).toBe('matter-2'));

    fireEvent.click(screen.getByRole('button', { name: 'Client Files' }));
    expect(lastBrowserProps()).toMatchObject({ clientId: 'client-1', rootLabel: 'Client Files' });
    expect(lastBrowserProps().rootFolders).toHaveLength(3);
    expect(onFilesChanged).toHaveBeenCalledTimes(2);
  });

  it('shows an empty matter as an empty folder', async () => {
    await renderTab({ clientFiles: new Map() });

    expect(screen.getByRole('button', { name: 'Smith v. Jones (#2024-001 · Empty) Matter' })).toBeInTheDocument();
  });

  it('opens a pending reveal in the matter it names, at its folder, with the file flashed', async () => {
    api.get('/lawfirms/firm-1/matters/matter-2/clients', { clients: [] });
    const trail = [{ id: 'folder-1', name: 'Leases' }];
    await renderTab({ revealMatterId: 'matter-2', revealTrail: trail, revealHighlightId: 'f3' });

    expect(lastBrowserProps()).toMatchObject({
      matterId: 'matter-2',
      initialTrail: trail,
      highlightFileId: 'f3',
    });
  });

  it("opens a reveal with no matter in the client's own area", async () => {
    const trail = [{ id: 'folder-2', name: 'General' }];
    await renderTab({ revealMatterId: null, revealTrail: trail, revealHighlightId: 'f9' });

    expect(lastBrowserProps()).toMatchObject({
      clientId: 'client-1',
      initialTrail: trail,
      highlightFileId: 'f9',
    });
  });

  it('shows the portal preview in place of the browser, without reading task folders', async () => {
    renderWithProviders(
      <ClientFilesTab
        previewMode
        clientId="client-1"
        clientName="Jane Smith"
        clientFiles={FILES}
        clientMatters={MATTERS}
        truncated={false}
        loading={false}
        lawFirmId="firm-1"
        onFilesChanged={jest.fn()}
        companyNames={new Map()}
      />
    );

    expect(await screen.findByTestId('portal-preview')).toBeInTheDocument();
    expect(screen.queryByTestId('files-section')).not.toBeInTheDocument();
    expect(api.callsTo('/files/list-client-tasks')).toHaveLength(0);
  });

  it('lists no folders when the client has no matters and no task holds files', async () => {
    await renderTab({ clientMatters: [] }, { tasks: [] });

    expect(lastBrowserProps()).toMatchObject({ clientId: 'client-1', rootFolders: [] });
  });

  it('lists each standalone task holding files as a badged folder, after the matters', async () => {
    await renderTab();

    const names = lastBrowserProps().rootFolders.map((folder: Folder) => folder.name);
    expect(names).toEqual(['Smith v. Jones', 'Acme Lease', 'Intake paperwork']);
    expect(screen.getByRole('button', { name: 'Intake paperwork (3 files) Task' })).toBeInTheDocument();
  });

  it("opens a task's files, shared with the task's clients, and leads back", async () => {
    api.get('/lawfirms/firm-1/tasks/task-1', {
      id: 'task-1',
      title: 'Intake paperwork',
      clientIds: ['client-1', 'client-3'],
      clientNames: ['Jane Smith', 'Sam Lee'],
    });
    const { onFilesChanged } = await renderTab();

    fireEvent.click(screen.getByRole('button', { name: /^Intake paperwork/ }));

    await waitFor(() => expect(lastBrowserProps()).toMatchObject({ taskId: 'task-1', rootLabel: 'Intake paperwork' }));
    expect(lastBrowserProps().clientId).toBeUndefined();
    expect(lastBrowserProps().matterId).toBeUndefined();
    await waitFor(() =>
      expect(lastBrowserProps().shareClients).toEqual([
        { id: 'client-1', name: 'Jane Smith' },
        { id: 'client-3', name: 'Sam Lee' },
      ])
    );

    fireEvent.click(screen.getByRole('button', { name: 'Client Files' }));
    expect(lastBrowserProps()).toMatchObject({ clientId: 'client-1', rootLabel: 'Client Files' });
    expect(onFilesChanged).toHaveBeenCalledTimes(2);
  });

  it("still shows the client's files and matters when the task read fails", async () => {
    await renderTab({}, { status: 500, body: { error: 'boom' } });

    const names = lastBrowserProps().rootFolders.map((folder: Folder) => folder.name);
    expect(names).toEqual(['Smith v. Jones', 'Acme Lease']);
  });
});

/**
 * A matter or task opened from here can carry more clients than the one whose
 * page this is. A share made with only this client known is recorded with no
 * restriction, which reaches EVERY client on the matter while the badge names
 * this one, so the browser (and its share controls) waits for the real list.
 *
 * WHAT BREAKS THESE: mounting the matter's or task's browser before its client
 * list has resolved, or falling back to "just this client" when that read
 * fails, rather than holding the browser back and offering to try again.
 */
describe('ClientFilesTab share recipients for a matter or task', () => {
  const MATTER_CLIENTS = [
    { id: 'client-1', name: 'Jane Smith', userId: 'user-1' },
    { id: 'client-2', name: 'John Smith', userId: null },
  ];

  /** Every props object the browser was rendered with while in this area. */
  const browserRendersIn = (key: 'matterId' | 'taskId', id: string) =>
    mockFilesSection.mock.calls.map(([props]) => props).filter((props) => props[key] === id);

  it("never shows a matter's browser with only this client as its audience while the matter's clients load", async () => {
    let release: ((body: unknown) => void) | undefined;
    api.get('/lawfirms/firm-1/matters/matter-1/clients', () => new Promise((resolve) => { release = resolve; }));
    await renderTab();

    fireEvent.click(screen.getByRole('button', { name: /^Smith v\. Jones/ }));
    await waitFor(() => expect(release).toBeDefined());

    expect(browserRendersIn('matterId', 'matter-1')).toEqual([]);

    release?.({ clients: MATTER_CLIENTS });
    await waitFor(() => expect(browserRendersIn('matterId', 'matter-1').length).toBeGreaterThan(0));
    for (const props of browserRendersIn('matterId', 'matter-1')) {
      expect(props.shareClients).toEqual(MATTER_CLIENTS);
    }
  });

  it("holds the matter's browser back when its clients cannot be read, and opens it on a retry", async () => {
    api.get(
      '/lawfirms/firm-1/matters/matter-1/clients',
      sequence({ status: 500, body: { error: 'boom' } }, { clients: MATTER_CLIENTS }),
    );
    await renderTab();

    fireEvent.click(screen.getByRole('button', { name: /^Smith v\. Jones/ }));

    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(browserRendersIn('matterId', 'matter-1')).toEqual([]);

    fireEvent.click(retry);
    await waitFor(() => expect(browserRendersIn('matterId', 'matter-1').length).toBeGreaterThan(0));
    for (const props of browserRendersIn('matterId', 'matter-1')) {
      expect(props.shareClients).toEqual(MATTER_CLIENTS);
    }
  });

  it("never shows a task's browser with only this client as its audience while the task loads", async () => {
    let release: ((body: unknown) => void) | undefined;
    api.get('/lawfirms/firm-1/tasks/task-1', () => new Promise((resolve) => { release = resolve; }));
    await renderTab();

    fireEvent.click(screen.getByRole('button', { name: /^Intake paperwork/ }));
    await waitFor(() => expect(release).toBeDefined());

    expect(browserRendersIn('taskId', 'task-1')).toEqual([]);

    release?.({ id: 'task-1', title: 'Intake paperwork', clientIds: ['client-1', 'client-3'], clientNames: ['Jane Smith', 'Sam Lee'] });
    await waitFor(() => expect(browserRendersIn('taskId', 'task-1').length).toBeGreaterThan(0));
    for (const props of browserRendersIn('taskId', 'task-1')) {
      expect(props.shareClients).toEqual([
        { id: 'client-1', name: 'Jane Smith' },
        { id: 'client-3', name: 'Sam Lee' },
      ]);
    }
  });
});
