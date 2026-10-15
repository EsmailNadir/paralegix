/**
 * The firm clients list: `RequirePermission` gating `ClientsPageTabs`, which
 * draws `ClientViewGrid`, the entry point for every client in the firm.
 *
 * `clients.service` and `requestDeduplicator` run for real against a faked
 * transport, so a wrong url, a swallowed error, or a stale response reaching a
 * switched firm fails the spec instead of a stubbed hook quietly returning
 * whatever the test handed it. Laid out section by section like
 * `matters/MattersListPage.test.tsx`, so the two lists are held to one standard.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

const useParamsMock = jest.fn();
const useSearchParamsMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/clients',
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

import LawFirmClientsPage from '@/app/lawfirm/[lawFirmId]/clients/page';
import { setupApiMock, sequence } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, grantOutsider, resetPermissions } from '../../../support/permissions';
import type { Client } from '@/types';

const FIRM_A = 'firm-a';
const FIRM_B = 'firm-b';
const API = 'http://localhost:5001/api';

const api = setupApiMock();

function clientsUrl(firmId: string): string {
  return `${API}/lawfirms/${firmId}/clients`;
}

/** The default first-page request: page 1, limit 10, name ascending - the grid's opening state. */
function defaultListUrl(firmId: string): string {
  return `${clientsUrl(firmId)}?limit=10&page=1&sort=name:asc`;
}

function client(overrides: Partial<Client> = {}): Client {
  return {
    id: 'client-1',
    name: 'Jane Smith',
    email: 'jane@example.com',
    phone: '555-0100',
    clientType: 'person',
    status: 'active',
    matterIds: ['m1', 'm2'],
    taskCount: 3,
    ...overrides,
  } as Client;
}

/** Every route the page fetches on mount, regardless of filters. */
function seedClientsWorkspace(opts: {
  firmId?: string;
  clients?: Client[];
  totalItems?: number;
  listUrl?: string;
} = {}) {
  const firmId = opts.firmId ?? FIRM_A;
  const rows = opts.clients ?? [];
  api.getExact(opts.listUrl ?? defaultListUrl(firmId), { clients: rows, totalItems: opts.totalItems ?? rows.length });
}

function renderClientsPage() {
  return renderWithProviders(<LawFirmClientsPage />);
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
  it('shows the real clients returned by the server', async () => {
    seedClientsWorkspace({
      clients: [
        client(),
        client({ id: 'client-2', name: 'Acme Holdings', clientType: 'company', email: null, phone: null, status: 'inactive', matterIds: [], taskCount: 0 }),
      ],
      totalItems: 2,
    });

    renderClientsPage();

    expect(await screen.findByText('Jane Smith')).toBeInTheDocument();
    expect(screen.getByText('Acme Holdings')).toBeInTheDocument();
    expect(screen.getByText('Clients (2)')).toBeInTheDocument();
    expect(screen.getByText(/jane@example\.com/)).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    // Each client row carries its counts from the list endpoint itself.
    expect(screen.getByText(/2 matters/)).toBeInTheDocument();
  });

  it('opens the client when its row is clicked', async () => {
    seedClientsWorkspace({ clients: [client()], totalItems: 1 });

    renderClientsPage();

    await userEvent.click(await screen.findByText('Jane Smith'));

    expect(mockNavigate).toHaveBeenCalledWith(`/lawfirm/${FIRM_A}/clients/client-1`);
  });
});

describe('a meaningful empty state', () => {
  it('says there are no clients rather than rendering a blank list', async () => {
    seedClientsWorkspace();

    renderClientsPage();

    expect(await screen.findByText('No clients yet')).toBeInTheDocument();
    expect(screen.getByText('Add clients to your matters to see them here.')).toBeInTheDocument();
    expect(screen.getByText('Clients (0)')).toBeInTheDocument();
  });
});

describe('an API failure, with retry', () => {
  it('tells the user the list failed to load rather than showing an empty list', async () => {
    api.getExact(defaultListUrl(FIRM_A), { status: 500, body: { error: 'clients service unavailable' } });

    renderClientsPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/clients service unavailable/i);
    expect(screen.queryByText('No clients yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('recovers the real list once the retry succeeds', async () => {
    api.getExact(defaultListUrl(FIRM_A), sequence(
      { status: 500, body: { error: 'clients service unavailable' } },
      { clients: [client()], totalItems: 1 },
    ));

    renderClientsPage();

    const retry = await screen.findByRole('button', { name: 'Try again' });
    await userEvent.click(retry);

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(await screen.findByText('Jane Smith')).toBeInTheDocument();
  });
});

describe('narrow role behavior', () => {
  it('opens the list for a baseline member without the write controls', async () => {
    grantBaselineMember();
    seedClientsWorkspace({ clients: [client()], totalItems: 1 });

    renderClientsPage();

    expect(await screen.findByText('Jane Smith')).toBeInTheDocument();
    // clients.view is baseline, but clients.manage is not.
    expect(screen.queryByRole('button', { name: 'New Client' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();
  });

  it('offers the write controls to a member who can manage clients', async () => {
    grantBaselineMember(['clients.manage']);
    seedClientsWorkspace({ clients: [client()], totalItems: 1 });

    renderClientsPage();

    expect(await screen.findByText('Jane Smith')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Client' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions for Jane Smith' })).toBeInTheDocument();
  });

  it('turns away a caller with no membership at all', async () => {
    grantOutsider();
    seedClientsWorkspace({ clients: [client()], totalItems: 1 });

    renderClientsPage();

    expect(await screen.findByText('You do not have access to this area')).toBeInTheDocument();
  });

  it('never requests the clients list for a viewer the page refuses to show anything to', async () => {
    grantOutsider();
    seedClientsWorkspace({ clients: [client()], totalItems: 1 });

    renderClientsPage();

    await screen.findByText('You do not have access to this area');
    // The grid is mounted INSIDE RequirePermission, so a refused viewer's render
    // never reaches the component that would fire the request.
    expect(api.callsTo('/clients')).toHaveLength(0);
  });
});

describe('a successful action: removing a client', () => {
  it('removes the client and refreshes the list', async () => {
    // The default test viewer holds every permission, so the row actions are on.
    api.getExact(defaultListUrl(FIRM_A), sequence(
      { clients: [client()], totalItems: 1 },
      { clients: [], totalItems: 0 },
    ));
    api.deleteExact(`${clientsUrl(FIRM_A)}/client-1`, { message: 'Client removed' });

    renderClientsPage();

    await screen.findByText('Jane Smith');
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Jane Smith' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Jane Smith/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove Client' }));

    await waitFor(() => expect(screen.queryByText('Jane Smith')).not.toBeInTheDocument());
    expect(await screen.findByText('No clients yet')).toBeInTheDocument();
    expect(await screen.findByText('Jane Smith has been removed.')).toBeInTheDocument();
    expect(api.callsTo('/clients/client-1')).toHaveLength(1);
  });
});

describe('a successful action: changing a client\'s status', () => {
  it('sends the new status and confirms it', async () => {
    api.getExact(defaultListUrl(FIRM_A), { clients: [client()], totalItems: 1 });
    api.putExact(`${clientsUrl(FIRM_A)}/client-1`, { message: 'Client updated' });

    renderClientsPage();

    await screen.findByText('Jane Smith');
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Jane Smith' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Active' }));

    const dialog = await screen.findByRole('dialog', { name: 'Change Status' });
    await userEvent.click(within(dialog).getByRole('button', { name: /^Status/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Inactive' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Jane Smith marked inactive.')).toBeInTheDocument();
    expect(api.calls('PUT')[0].body).toEqual({ status: 'inactive' });
  });
});

describe('a refused action: the remove fails', () => {
  it('tells the user the client was not removed, and leaves it in the list', async () => {
    seedClientsWorkspace({ clients: [client()], totalItems: 1 });
    api.deleteExact(`${clientsUrl(FIRM_A)}/client-1`, {
      status: 409, body: { error: 'This client has open invoices and cannot be removed' },
    });

    renderClientsPage();

    await screen.findByText('Jane Smith');
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Jane Smith' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove Client' }));

    expect(await screen.findByText(/open invoices and cannot be removed/i)).toBeInTheDocument();
    // Still in the list - the removal never actually happened.
    expect(screen.getByText('Jane Smith')).toBeInTheDocument();
  });
});

describe('a law firm switch while a request is pending', () => {
  it('never lets a slow response for the old firm land as the new firm\'s client list', async () => {
    api.getExact(defaultListUrl(FIRM_A), { delayMs: 200, body: { clients: [client({ name: 'Firm A Client' })], totalItems: 1 } });
    seedClientsWorkspace({ firmId: FIRM_B, clients: [client({ id: 'client-b', name: 'Firm B Client' })], totalItems: 1 });

    const { rerender } = renderClientsPage();

    // Firm A's slow request is still in flight when the viewer switches firms.
    useParamsMock.mockReturnValue({ lawFirmId: FIRM_B });
    rerender(<LawFirmClientsPage />);

    expect(await screen.findByText('Firm B Client')).toBeInTheDocument();

    // Even once firm A's slow response finally arrives, it must not overwrite
    // the list now attributed to firm B.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByText('Firm B Client')).toBeInTheDocument();
    expect(screen.queryByText('Firm A Client')).not.toBeInTheDocument();
  });
});
