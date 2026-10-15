/**
 * The client detail route: `RequirePermission` gating `ClientDetail`, driven
 * through the REAL clients and tasks services against a faked transport.
 *
 * Like the matter and task pages, this one holds its client in plain
 * `useState` + `useEffect` rather than React Query, so nothing but its own
 * `cancelled` flag stops a slow response for the OLD client landing on a
 * viewer who has already moved to another. The header actions (portal invite,
 * remove, erase) are pinned in `tests/components/clientComp/ClientDetailHeaderActions.test.tsx`;
 * this file covers the page itself: what it shows, what it does when the read
 * fails, which tabs a role sees, and the `?tab=` deep link.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/messages.service');
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

const useParamsMock = jest.fn();
const useSearchParamsMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/clients/client-1',
  useParams: () => useParamsMock(),
  useSearchParams: () => useSearchParamsMock(),
}));

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

import React from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import ClientDetailPage from '@/app/lawfirm/[lawFirmId]/clients/[clientId]/page';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../../support/apiMock';
import { grantBaselineMember, grantOutsider, grantPermissions, resetPermissions } from '../../../support/permissions';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const FIRM = 'firm-1';
const CLIENT_1 = 'client-1';
const CLIENT_2 = 'client-2';

let api: ApiMock;

function clientUrl(id: string) {
  return `/lawfirms/${FIRM}/clients/${id}`;
}

function person(overrides: Record<string, unknown> = {}) {
  return { id: CLIENT_1, name: 'Dana Client', email: 'dana@example.com', clientType: 'person', ...overrides };
}

function serveClient(id: string, body: Record<string, unknown>) {
  api.getExact(`http://localhost:5001/api${clientUrl(id)}`, { client: body });
  api.get(`${clientUrl(id)}/summary`, { clientId: id, matters: null, billing: null });
}

function renderPage() {
  return renderWithProviders(<ClientDetailPage />);
}

beforeEach(() => {
  api = installApiMock();
  // The page also asks for conversations, relationships, events and lookups this spec does not examine.
  api.allowUnhandled();
  __resetDuplicateRequestGuard();
  mockNavigate.mockReset();
  useParamsMock.mockReturnValue({ lawFirmId: FIRM, clientId: CLIENT_1 });
  useSearchParamsMock.mockReturnValue(new URLSearchParams());
  api.get('/lawfirms/firm-1/tasks', { tasks: [], totalTasks: 0 });
  api.get('/lawfirms/firm-1/messaging/conversations', { conversations: [] });
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

describe('loaded content', () => {
  it('shows the real client: name, contact details and profile', async () => {
    serveClient(CLIENT_1, person({ phone: '555-0100' }));

    renderPage();

    expect(await screen.findByRole('heading', { name: /Dana Client/ })).toBeInTheDocument();
    expect(screen.getAllByText('dana@example.com').length).toBeGreaterThan(0);
    expect(screen.getAllByText('555-0100').length).toBeGreaterThan(0);
    expect(screen.getByText('Client Profile')).toBeInTheDocument();
  });

  it('labels an organization as an Organization, not a Company', async () => {
    serveClient(CLIENT_1, { id: CLIENT_1, name: 'Acme Holdings', clientType: 'company' });

    renderPage();

    await screen.findByRole('heading', { name: /Acme Holdings/ });
    expect(screen.getByText('Organization Client')).toBeInTheDocument();
    expect(screen.queryByText(/Company Client/)).not.toBeInTheDocument();
  });
});

describe('a meaningful empty state', () => {
  it('says the client has no tasks, rather than leaving the tab blank', async () => {
    serveClient(CLIENT_1, person());

    renderPage();
    await screen.findByRole('heading', { name: /Dana Client/ });
    fireEvent.click(screen.getByRole('button', { name: /^Tasks/ }));

    expect(await screen.findByText('No tasks found for this client')).toBeInTheDocument();
  });
});

describe('an API failure', () => {
  // Red if: the not-found screen swallows the real reason, so a timeout reads as "this client may have been removed".
  it('shows the real error rather than claiming the client was removed', async () => {
    api.getExact(`http://localhost:5001/api${clientUrl(CLIENT_1)}`, { status: 500, body: { error: 'clients service unavailable' } });
    api.get(`${clientUrl(CLIENT_1)}/summary`, { clientId: CLIENT_1, matters: null, billing: null });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/clients service unavailable/i);
  });

  it('offers a way back to the clients list', async () => {
    api.getExact(`http://localhost:5001/api${clientUrl(CLIENT_1)}`, { status: 500, body: { error: 'clients service unavailable' } });
    api.get(`${clientUrl(CLIENT_1)}/summary`, { clientId: CLIENT_1, matters: null, billing: null });

    renderPage();

    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /Back to Clients/i }));
    expect(mockNavigate).toHaveBeenCalledWith(`/lawfirm/${FIRM}/clients`);
  });
});

describe('narrow role behavior', () => {
  it('shows a baseline member the client read-only, with no edit, invite or menu controls', async () => {
    grantBaselineMember();
    serveClient(CLIENT_1, person());

    renderPage();

    expect(await screen.findByRole('heading', { name: /Dana Client/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite to Portal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('shows a member with no client access the access screen and reads nothing', async () => {
    grantOutsider();
    serveClient(CLIENT_1, person());

    renderPage();

    await waitFor(() => expect(screen.queryByRole('heading', { name: /Dana Client/ })).not.toBeInTheDocument());
    expect(api.calls('GET').some((c) => c.pathname.endsWith(clientUrl(CLIENT_1)))).toBe(false);
  });

  // The firm conversations read needs messaging.view on the backend, so a role without it must
  // neither see the tab nor ask. Red if: either gate is removed.
  describe('without messaging.view', () => {
    const NO_MESSAGING = ['clients.view', 'tasks.view', 'matters.view'];

    it('shows no Messages tab and no unread-messages tile', async () => {
      grantPermissions(NO_MESSAGING);
      serveClient(CLIENT_1, person({ userId: 'portal-1' }));

      renderPage();
      await screen.findByRole('heading', { name: /Dana Client/ });

      expect(screen.queryByRole('button', { name: /^Messages/ })).not.toBeInTheDocument();
      expect(screen.queryByText('Unread Messages')).not.toBeInTheDocument();
    });

    it('never requests the firm conversations', async () => {
      grantPermissions(NO_MESSAGING);
      serveClient(CLIENT_1, person({ userId: 'portal-1' }));

      renderPage();
      await screen.findByRole('heading', { name: /Dana Client/ });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(api.calls().some((c) => c.pathname.includes('/messaging/conversations'))).toBe(false);
    });

    it('requests them for a member who can view messaging', async () => {
      grantPermissions([...NO_MESSAGING, 'messaging.view']);
      serveClient(CLIENT_1, person({ userId: 'portal-1' }));

      renderPage();
      await screen.findByRole('heading', { name: /Dana Client/ });

      await waitFor(() => expect(api.calls().some((c) => c.pathname.includes('/messaging/conversations'))).toBe(true));
      expect(screen.getByRole('button', { name: /^Messages/ })).toBeInTheDocument();
    });
  });
});

describe('the ?tab= deep link', () => {
  it('lands on the Overview for a tab that does not exist', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('tab=bogus'));
    serveClient(CLIENT_1, person());

    renderPage();
    await screen.findByRole('heading', { name: /Dana Client/ });

    expect(screen.getByText('Client Profile')).toBeInTheDocument();
  });

  // Red if: the deep link opens a tab the strip does not show, so the page renders a panel nobody can reach.
  it('lands on the Overview when the tab is Messages and the member cannot view messaging', async () => {
    grantPermissions(['clients.view', 'tasks.view', 'matters.view']);
    useSearchParamsMock.mockReturnValue(new URLSearchParams('tab=messages'));
    serveClient(CLIENT_1, person({ userId: 'portal-1' }));

    renderPage();
    await screen.findByRole('heading', { name: /Dana Client/ });

    expect(screen.getByText('Client Profile')).toBeInTheDocument();
  });

  it('opens the Tasks tab from the link', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('tab=tasks'));
    serveClient(CLIENT_1, person());

    renderPage();
    await screen.findByRole('heading', { name: /Dana Client/ });

    expect(await screen.findByText('No tasks found for this client')).toBeInTheDocument();
  });
});

describe('the Time Tracking tab', () => {
  // The time-entry list read needs billing.viewTimeEntries, which is not part of the member
  // baseline. Red if: the tab is offered without it, so it opens onto a failed read.
  it('is not offered to a baseline member', async () => {
    grantBaselineMember();
    serveClient(CLIENT_1, person());

    renderPage();
    await screen.findByRole('heading', { name: /Dana Client/ });

    expect(screen.queryByRole('button', { name: /^Time Tracking/ })).not.toBeInTheDocument();
  });

  it('lands on the Overview, not a Time Tracking panel, for a ?tab=time-tracking link without the permission', async () => {
    grantBaselineMember();
    useSearchParamsMock.mockReturnValue(new URLSearchParams('tab=time-tracking'));
    serveClient(CLIENT_1, person());

    renderPage();
    await screen.findByRole('heading', { name: /Dana Client/ });

    expect(screen.getByText('Client Profile')).toBeInTheDocument();
    expect(api.calls().some((c) => c.pathname.includes('/billing/time-entries'))).toBe(false);
  });

  it('is offered to a member who can view time entries', async () => {
    grantBaselineMember(['billing.viewTimeEntries']);
    serveClient(CLIENT_1, person());

    renderPage();
    await screen.findByRole('heading', { name: /Dana Client/ });

    expect(screen.getByRole('button', { name: /^Time Tracking/ })).toBeInTheDocument();
  });
});

describe('the Billing tab', () => {
  // The invoice and plan reads need billing.viewInvoices, which is not part of the member
  // baseline. Red if: the tab is offered without it, so it opens onto silently empty data.
  function billingReads(): string[] {
    return api.calls().map((c) => c.pathname).filter((p) => /\/(invoices|plans)\b/.test(p));
  }

  it('is not offered to a baseline member', async () => {
    grantBaselineMember();
    serveClient(CLIENT_1, person());

    renderPage();
    await screen.findByRole('heading', { name: /Dana Client/ });

    expect(screen.queryByRole('button', { name: /^Billing/ })).not.toBeInTheDocument();
  });

  it('lands on the Overview and reads no invoices or plans for a ?tab=billing link without the permission', async () => {
    grantBaselineMember();
    useSearchParamsMock.mockReturnValue(new URLSearchParams('tab=billing'));
    serveClient(CLIENT_1, person());

    renderPage();
    await screen.findByRole('heading', { name: /Dana Client/ });

    expect(screen.getByText('Client Profile')).toBeInTheDocument();
    expect(billingReads()).toEqual([]);
  });

  it('is offered to a member who can view invoices, and loads invoices and plans on a deep link', async () => {
    grantBaselineMember(['billing.viewInvoices']);
    useSearchParamsMock.mockReturnValue(new URLSearchParams('tab=billing'));
    serveClient(CLIENT_1, person());
    api.get('/lawfirms/firm-1/billing/invoices/firm', { invoices: [], totalItems: 0 });
    api.get('/lawfirms/firm-1/billing/plans', { plans: [] });

    renderPage();
    await screen.findByRole('heading', { name: /Dana Client/ });

    expect(screen.getAllByRole('button', { name: /^Billing/ }).some((b) => b.getAttribute('aria-current') === 'true')).toBe(true);
    await waitFor(() => expect(billingReads().some((p) => p.includes('/invoices'))).toBe(true));
    expect(billingReads().some((p) => p.includes('/plans'))).toBe(true);
  });
});

describe('the Billing tab status filter', () => {
  // Red if: the Voided option is dropped, or selecting it requests another status.
  it('offers Voided last and requests status=voided when it is picked', async () => {
    grantBaselineMember(['billing.viewInvoices']);
    useSearchParamsMock.mockReturnValue(new URLSearchParams('tab=billing'));
    serveClient(CLIENT_1, person());
    api.get('/lawfirms/firm-1/billing/invoices/firm', { invoices: [], totalItems: 0 });
    api.get('/lawfirms/firm-1/billing/plans', { plans: [] });

    renderPage();
    await screen.findByRole('heading', { name: /Dana Client/ });

    fireEvent.click(await screen.findByRole('button', { name: /^Status/ }));
    const options = screen.getAllByRole('option');
    expect(options[options.length - 1]).toHaveTextContent('Voided');

    fireEvent.click(screen.getByRole('option', { name: 'Voided' }));

    await waitFor(() =>
      expect(
        api.calls().some((c) => c.pathname.includes('/invoices/firm') && String(c.url).includes('status=voided')),
      ).toBe(true),
    );
  });
});

describe('notes on a client', () => {
  // Note time is billing work: the backend requires billing.manageTimeEntries on top of
  // clients.manage. Red if: the control is offered on clients.manage alone.
  async function openComposer() {
    api.get('/notes', { notes: [], totalNotes: 0, counts: { all: 0, withTime: 0, withoutTime: 0 }, tags: [] });
    api.get('/note-types', { noteTypes: [] });
    api.get('/note-templates', { noteTemplates: [] });
    serveClient(CLIENT_1, person());

    renderPage();
    await screen.findByRole('heading', { name: /Dana Client/ });
    fireEvent.click(screen.getByRole('button', { name: /^Notes/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Add Note/i }));
    await screen.findByRole('button', { name: /Save Note/ });
  }

  it('offers no time controls to a member who can manage clients but not time entries', async () => {
    grantBaselineMember(['clients.manage']);

    await openComposer();

    expect(screen.queryByRole('button', { name: 'More save options' })).not.toBeInTheDocument();
  });

  it('offers the time controls once the member can also manage time entries', async () => {
    grantBaselineMember(['clients.manage', 'billing.manageTimeEntries']);

    await openComposer();

    expect(screen.getByRole('button', { name: 'More save options' })).toBeInTheDocument();
  });
});

describe('a refused action: the removal fails', () => {
  it('tells the user the client was not removed, and stays on the page', async () => {
    serveClient(CLIENT_1, person());
    api.deleteExact(`http://localhost:5001/api${clientUrl(CLIENT_1)}`, { status: 409, body: { error: 'Client still has open invoices' } });

    renderPage();
    await screen.findByRole('heading', { name: /Dana Client/ });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove Client' }));

    expect(await screen.findByText('Client still has open invoices')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Dana Client/ })).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('a client switch while a request is pending', () => {
  it('never lets a slow response for the old client land as the new client\'s detail', async () => {
    serveClient(CLIENT_1, person({ id: CLIENT_1 }));
    serveClient(CLIENT_2, person({ id: CLIENT_2, name: 'New Fast Client' }));
    // Registered LAST so it wins over the plain route `serveClient` just set up for the same url.
    api.getExact(`http://localhost:5001/api${clientUrl(CLIENT_1)}`, { delayMs: 200, body: { client: person({ id: CLIENT_1, name: 'Old Slow Client' }) } });

    const { rerender } = renderPage();

    // Client 1's slow response is still in flight when the viewer navigates to client 2.
    useParamsMock.mockReturnValue({ lawFirmId: FIRM, clientId: CLIENT_2 });
    rerender(<ClientDetailPage />);

    expect(await screen.findByRole('heading', { name: /New Fast Client/ })).toBeInTheDocument();

    // Even once client 1's slow response finally arrives, it must not overwrite the page now showing client 2.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByRole('heading', { name: /New Fast Client/ })).toBeInTheDocument();
    expect(screen.queryByText('Old Slow Client')).not.toBeInTheDocument();
  });
});

it('retries a failed client read and replaces the failure with the client details', async () => {
  let attempts = 0;
  api.getExact(`http://localhost:5001/api${clientUrl(CLIENT_1)}`, () => {
    attempts += 1;
    return attempts === 1 ? { status: 500, body: { error: 'client read unavailable' } } : { client: person() };
  });
  api.get(`${clientUrl(CLIENT_1)}/summary`, { clientId: CLIENT_1, matters: null, billing: null });
  renderPage();
  expect(await screen.findByRole('alert')).toHaveTextContent('client read unavailable');
  expect(screen.queryByText('Client not found')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('heading', { name: /Dana Client/ })).toBeInTheDocument();
  expect(attempts).toBe(2);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('clears the previous client when the new client read fails', async () => {
  serveClient(CLIENT_1, person());
  api.getExact(`http://localhost:5001/api${clientUrl(CLIENT_2)}`, { status: 500, body: { error: 'new client read unavailable' } });
  api.get(`${clientUrl(CLIENT_2)}/summary`, { clientId: CLIENT_2, matters: null, billing: null });
  const { rerender } = renderPage();
  expect(await screen.findByRole('heading', { name: /Dana Client/ })).toBeInTheDocument();
  useParamsMock.mockReturnValue({ lawFirmId: FIRM, clientId: CLIENT_2 });
  rerender(<ClientDetailPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('new client read unavailable');
  expect(screen.queryByRole('heading', { name: /Dana Client/ })).not.toBeInTheDocument();
});
