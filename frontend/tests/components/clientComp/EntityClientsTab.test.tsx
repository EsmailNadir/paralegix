/**
 * The attached-clients tab, held to one contract across matters and tasks.
 *
 * Matters, tasks and clients keep growing the same features, and the copies
 * drift without any one screen looking broken. The attached-clients tab is the
 * clearest case: `EntityClientsTab` draws the list, `AttachClientModal` does the
 * search / attach flow, and each parent supplies only an adapter (its attach and
 * detach requests, and the query keys its page reads). Every behaviour below is
 * asserted once per parent through the same harness, so a change that fixes one
 * parent and not the other fails here instead of shipping as drift.
 *
 * The clients, matters and tasks services run for real against a faked
 * transport, so the request each parent sends is what is asserted, not a spy on
 * an adapter.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/matters.service');
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/hooks/useEntityLookup');
jest.mock('@/components/clientComp/ClientOrganizationAutocomplete', () => ({
  __esModule: true,
  default: () => null,
}));

import React, { useState } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import EntityClientsTab, { type EntityClientItem } from '@/components/clientComp/EntityClientsTab';
import AttachClientModal, { type AttachClientTarget } from '@/components/clientComp/AttachClientModal';
import AddClientModal from '@/components/matterComp/AddClientModal';
import AddTaskClientModal from '@/components/taskComp/AddTaskClientModal';
import { useEntityLookup, useDuplicateNameCheck } from '@/hooks/useEntityLookup';

const FIRM = 'firm-1';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  (useDuplicateNameCheck as jest.Mock).mockReturnValue({ duplicate: null });
  (useEntityLookup as jest.Mock).mockReturnValue({ items: [], hasMore: false, loading: false });
});

afterEach(() => {
  api.restore();
});

const person = (id: string, name: string, overrides: Partial<EntityClientItem> = {}): EntityClientItem => ({
  id, name, clientType: 'person', ...overrides,
});

type ParentCase = {
  parent: 'matter' | 'task';
  /** Requests the parent sends to attach `c1` while `c-old` is already attached. */
  attached: (calls: ApiMock) => unknown;
};

/** The parent page's own list + its add modal, wired the way the pages wire them. */
function Harness({ parent, clients }: { parent: 'matter' | 'task'; clients: EntityClientItem[] }) {
  const [open, setOpen] = useState(false);
  const ids = clients.map((c) => c.id);
  return (
    <>
      <EntityClientsTab lawFirmId={FIRM} clients={clients} canManageClients onAddClientClick={() => setOpen(true)} />
      {parent === 'matter' ? (
        <AddClientModal open={open} onClose={() => setOpen(false)} lawFirmId={FIRM} matterId="matter-1" existingMatterClientIds={ids} />
      ) : (
        <AddTaskClientModal open={open} onClose={() => setOpen(false)} lawFirmId={FIRM} taskId="task-1" existingClientIds={ids} />
      )}
    </>
  );
}

function seedSearchResult(item: { id: string; label: string; sublabel?: string; clientType?: 'person' | 'company' }) {
  (useEntityLookup as jest.Mock).mockReturnValue({ items: [item], hasMore: false, loading: false });
}

describe.each<ParentCase>([
  { parent: 'matter', attached: (m) => m.callsTo('/matters/matter-1/clients') },
  { parent: 'task', attached: (m) => m.callsTo('/tasks/task-1') },
])('attaching a client to a $parent', ({ parent }) => {
  const attachedClients = [person('c-old', 'Olga Existing')];

  /** What this parent's attach request carries for the client that was picked. */
  const attachRequest = () =>
    parent === 'matter' ? api.callsTo('/matters/matter-1/clients') : api.callsTo('/tasks/task-1');

  function seedParentRoutes() {
    api.get('/clients/c1', { id: 'c1', name: 'Alice Smith', clientType: 'person' });
    // The roster read for the client already attached (a task passes it; the
    // matter harness passes it too, so both parents see the same shape).
    api.get('/clients/c-old/contacts', { contacts: [] });
    if (parent === 'matter') api.post('/matters/matter-1/clients', { message: 'added' });
    else api.put('/tasks/task-1', { message: 'updated' });
  }

  async function pickAlice(user: ReturnType<typeof userEvent.setup>) {
    seedSearchResult({ id: 'c1', label: 'Alice Smith', sublabel: 'alice@example.com' });
    await user.click(screen.getByRole('button', { name: 'Add Client' }));
    await user.click(await screen.findByText('Alice Smith'));
  }

  it("sends the parent's own attach request for the picked client", async () => {
    const user = userEvent.setup();
    seedParentRoutes();
    renderWithProviders(<Harness parent={parent} clients={attachedClients} />);

    await pickAlice(user);

    await waitFor(() => expect(attachRequest()).toHaveLength(1));
    const [call] = attachRequest();
    if (parent === 'matter') {
      expect(call.method).toBe('POST');
      expect(call.body).toEqual({ client: { clientId: 'c1', name: 'Alice Smith' } });
    } else {
      expect(call.method).toBe('PUT');
      // A task saves its clients as a whole list, so the one already attached
      // must ride along or attaching Alice would silently detach Olga.
      expect(call.body).toEqual({ clientIds: ['c-old', 'c1'] });
    }
  });

  it('refreshes what the parent page and the firm client lists read', async () => {
    const user = userEvent.setup();
    seedParentRoutes();
    const { queryClient } = renderWithProviders(<Harness parent={parent} clients={attachedClients} />);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    await pickAlice(user);

    await waitFor(() => expect(attachRequest()).toHaveLength(1));
    const keys = invalidate.mock.calls.map(([filters]) => (filters as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(['clients', FIRM]);
    expect(keys).toContainEqual([parent === 'matter' ? 'matters' : 'tasks', FIRM]);
  });

  it('closes the dialog once the client is attached', async () => {
    const user = userEvent.setup();
    seedParentRoutes();
    renderWithProviders(<Harness parent={parent} clients={attachedClients} />);

    await pickAlice(user);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the dialog open and says why when the parent refuses the client', async () => {
    const user = userEvent.setup();
    seedParentRoutes();
    if (parent === 'matter') api.post('/matters/matter-1/clients', { status: 403, body: { error: 'You cannot add clients to this matter' } });
    else api.put('/tasks/task-1', { status: 403, body: { error: 'You cannot add clients to this task' } });
    renderWithProviders(<Harness parent={parent} clients={attachedClients} />);

    await pickAlice(user);

    expect(await screen.findByText(/You cannot add clients to this/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it("drops the people already attached when the organization they belong to is attached", async () => {
    const user = userEvent.setup();
    const withPat = [person('p1', 'Pat Roster')];
    api.get('/clients/org-1', { id: 'org-1', name: 'Acme Holdings', clientType: 'company' });
    api.get('/clients/org-1/contacts', { contacts: [{ id: 'link-1', personClientId: 'p1', name: 'Pat Roster' }] });
    api.get('/clients/p1', { id: 'p1', name: 'Pat Roster', clientType: 'person' });
    api.get('/clients/p1/contacts', { contacts: [] });
    if (parent === 'matter') {
      api.delete('/matters/matter-1/clients/p1', { message: 'removed' });
      api.post('/matters/matter-1/clients', { message: 'added' });
    } else {
      api.put('/tasks/task-1', { message: 'updated' });
    }
    seedSearchResult({ id: 'org-1', label: 'Acme Holdings', clientType: 'company' });
    renderWithProviders(<Harness parent={parent} clients={withPat} />);

    await user.click(screen.getByRole('button', { name: 'Add Client' }));
    await user.click(await screen.findByText('Acme Holdings'));

    if (parent === 'matter') {
      await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
      expect(api.calls('DELETE').map((c) => c.pathname)).toEqual(['/api/lawfirms/firm-1/matters/matter-1/clients/p1']);
      expect(api.calls('POST').map((c) => c.body)).toEqual([{ client: { clientId: 'org-1', name: 'Acme Holdings' } }]);
    } else {
      await waitFor(() => expect(api.calls('PUT')).toHaveLength(2));
      // Detach the person first, then attach the organization: the list a task
      // ends up with is the organization alone.
      expect(api.calls('PUT').map((c) => c.body)).toEqual([{ clientIds: [] }, { clientIds: ['org-1'] }]);
    }
  });
});

describe('a parent that cannot detach a client', () => {
  it('leaves the people already attached alone when an organization is attached', async () => {
    const user = userEvent.setup();
    const attach = jest.fn().mockResolvedValue(undefined);
    // No `detach`: the adapter has no way to remove the superseded rows, so the
    // roster cleanup must be skipped rather than attempted and failed.
    const target: AttachClientTarget = { label: 'Record', attachedClientIds: ['p1'], attach, invalidateKeys: [] };
    api.get('/clients/org-1', { id: 'org-1', name: 'Acme Holdings', clientType: 'company' });
    api.get('/clients/org-1/contacts', { contacts: [{ id: 'link-1', personClientId: 'p1', name: 'Pat Roster' }] });
    api.get('/clients/p1/contacts', { contacts: [] });
    seedSearchResult({ id: 'org-1', label: 'Acme Holdings', clientType: 'company' });

    renderWithProviders(<AttachClientModal open onClose={jest.fn()} lawFirmId={FIRM} target={target} />);
    await user.click(await screen.findByText('Acme Holdings'));

    await waitFor(() => expect(attach).toHaveBeenCalledWith({ clientId: 'org-1', name: 'Acme Holdings' }));
    expect(api.calls().filter((c) => c.method === 'DELETE' || c.method === 'PUT')).toEqual([]);
  });
});

describe('the rows on the tab', () => {
  it('offers Remove only when the parent supplies a way to remove', () => {
    const clients = [person('c1', 'Alice Smith')];
    const { unmount } = renderWithProviders(
      <EntityClientsTab lawFirmId={FIRM} clients={clients} canManageClients />,
    );
    // The row is there, so the missing button is the parent not offering it.
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Alice Smith' })).not.toBeInTheDocument();
    unmount();

    const onRemoveClient = jest.fn();
    renderWithProviders(
      <EntityClientsTab lawFirmId={FIRM} clients={clients} canManageClients onRemoveClient={onRemoveClient} />,
    );
    return userEvent.click(screen.getByRole('button', { name: 'Remove Alice Smith' })).then(() => {
      expect(onRemoveClient).toHaveBeenCalledWith({ id: 'c1', name: 'Alice Smith' });
    });
  });

  it('shows no row actions or add button to a viewer who cannot manage clients', () => {
    renderWithProviders(
      <EntityClientsTab
        lawFirmId={FIRM}
        clients={[person('c1', 'Alice Smith')]}
        onAddClientClick={jest.fn()}
        onRemoveClient={jest.fn()}
        onEditClient={jest.fn()}
      />,
    );

    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Client' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Remove|Edit) Alice Smith$/ })).not.toBeInTheDocument();
  });

  it('names its search box and lets the user clear it', async () => {
    const user = userEvent.setup();
    const clients = ['Ann', 'Ben', 'Cal', 'Dee', 'Eli', 'Fay'].map((n, i) => person(`c${i}`, `${n} Client`));
    renderWithProviders(<EntityClientsTab lawFirmId={FIRM} clients={clients} showSearch />);

    const box = screen.getByRole('textbox', { name: 'Search clients' });
    await user.type(box, 'ben');
    expect(screen.queryByText('Ann Client')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(box).toHaveValue('');
    expect(screen.getByText('Ann Client')).toBeInTheDocument();
  });

  it('keeps the add button on the right of the same toolbar row as the count', () => {
    renderWithProviders(
      <EntityClientsTab lawFirmId={FIRM} clients={[person('c1', 'Alice Smith')]} canManageClients onAddClientClick={jest.fn()} />,
    );

    const count = screen.getByText('1 client');
    const add = screen.getByRole('button', { name: 'Add Client' });
    const row = count.closest('div.justify-between');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole('button', { name: 'Add Client' })).toBe(add);
  });
});
