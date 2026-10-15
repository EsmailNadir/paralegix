/**
 * The portal's per-firm conversation page and the all-firms list that opens it.
 *
 * Which thread is open is the url's `?c=`: a list row, a search hit and the
 * switcher all write it, so Back and Forward move between threads and a direct
 * link never falls through to whichever thread happens to be newest. The
 * switcher always offers the personal thread to a client with a person record,
 * even before that thread exists, and its unread counts follow reads and live
 * activity.
 *
 * The portal service runs for real against a faked transport. `ConversationView`
 * is a stub that names the thread it was opened on: its own specs cover the
 * thread itself, and these cases pin which thread the page opens.
 */
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/components/messagesComp/ConversationView', () => ({
  __esModule: true,
  default: (props: { conversationId: string; isGroup?: boolean }) => (
    <div data-testid="conversation-view">{props.isGroup ? 'group' : 'direct'}:{props.conversationId}</div>
  ),
}));

const mockUseConversations = jest.fn();
jest.mock('@/hooks/useConversations', () => ({
  useConversations: (options: unknown) => mockUseConversations(options),
}));

let mockSearch = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/client/messages/firm-1',
  useParams: () => ({ lawFirmId: 'firm-1' }),
  useSearchParams: () => mockSearch,
}));

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

import React from 'react';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ClientConversationPage from '@/app/client/messages/[lawFirmId]/page';
import ClientMessagesPage from '@/app/client/messages/page';
import { ClientPortalContext, type ClientPortalAssociation } from '@/contexts/ClientPortalContext';
import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const FIRM = 'firm-1';
const LIST = `/api/client-portal/lawfirm/${FIRM}/messages/conversations`;
const PERSONAL_KEY = `${FIRM}_test-uid`;

const PERSON: ClientPortalAssociation = {
  clientRecordId: 'rec-person',
  clientType: 'person',
  clientName: 'Pat Client',
  companyLinkId: null,
  canViewBilling: true,
};

function summary(overrides: Record<string, unknown>) {
  return {
    conversationType: 'group',
    clientRecordId: 'rec-company',
    clientType: 'company',
    title: '',
    lastMessageAt: '2026-09-01T10:00:00.000Z',
    lastMessagePreview: '',
    unreadCount: 0,
    archivedAt: null,
    ...overrides,
  };
}

const DIRECT = summary({ conversationId: 'direct-1', conversationType: 'direct', clientRecordId: 'rec-person', clientType: 'person', title: '' });
const ACME = summary({ conversationId: 'g-acme', title: 'Acme Corp', lastMessageAt: '2026-09-03T10:00:00.000Z' });
const BOARD = summary({ conversationId: 'g-board', title: 'Board prep', clientType: 'person', lastMessageAt: '2026-09-02T10:00:00.000Z' });

let api: ApiMock;

function contextValue(associations: ClientPortalAssociation[]) {
  return {
    lawFirms: [{ id: FIRM, name: 'Test Firm' }],
    associations,
    associationsLoading: false,
    activeAssociation: associations[0] ?? null,
    selectionRequired: false,
    setActiveClientRecordId: () => {},
  };
}

function renderPage(associations: ClientPortalAssociation[] = [PERSON]) {
  const ui = () => (
    <ClientPortalContext.Provider value={contextValue(associations)}>
      <ClientConversationPage />
    </ClientPortalContext.Provider>
  );
  const view = renderWithProviders(ui());
  return { ...view, rerenderPage: () => view.rerender(ui()) };
}

const openThread = () => screen.getByTestId('conversation-view');
const tab = (name: RegExp) => screen.getByRole('button', { name });

beforeEach(() => {
  api = installApiMock();
  __resetDuplicateRequestGuard();
  mockSearch = new URLSearchParams();
  mockNavigate.mockReset();
  mockUseConversations.mockReset();
  mockUseConversations.mockReturnValue({ conversations: [], loading: false, error: null });
});

afterEach(() => {
  api.restore();
});

describe('the switcher drives the url', () => {
  it('writes the picked thread into ?c= and follows the url back to an earlier pick', async () => {
    api.getExact(LIST, { conversations: [ACME, BOARD, DIRECT], totalItems: 3 });
    mockSearch = new URLSearchParams('c=g-board');
    const { rerenderPage } = renderPage();

    await waitFor(() => expect(openThread()).toHaveTextContent('group:g-board'));

    await userEvent.click(tab(/Personal/));
    // Red on a switcher that keys the personal thread by firm alone.
    expect(mockNavigate).toHaveBeenCalledWith(`/client/messages/${FIRM}?c=direct-1`);

    // The navigation lands, then the user presses Back.
    mockSearch = new URLSearchParams('c=direct-1');
    rerenderPage();
    expect(openThread()).toHaveTextContent(`direct:${PERSONAL_KEY}`);
    mockSearch = new URLSearchParams('c=g-board');
    rerenderPage();
    // Red on a switcher whose own pick outranks the url.
    expect(openThread()).toHaveTextContent('group:g-board');
  });

  it('opens the personal thread a link names even when a group is newer', async () => {
    api.getExact(LIST, { conversations: [ACME, DIRECT], totalItems: 2 });
    mockSearch = new URLSearchParams('c=direct-1');
    renderPage();

    await waitFor(() => expect(openThread()).toHaveTextContent(`direct:${PERSONAL_KEY}`));
    expect(tab(/Personal/)).toHaveAttribute('aria-current', 'true');
  });
});

describe('a client whose only threads are groups', () => {
  it('still offers a personal thread to a client with a person record', async () => {
    api.getExact(LIST, { conversations: [ACME], totalItems: 1 });
    const { rerenderPage } = renderPage([PERSON]);

    await waitFor(() => expect(openThread()).toHaveTextContent('group:g-acme'));
    // Red on a page that hides the switcher behind a single conversation.
    await userEvent.click(tab(/Personal/));
    expect(mockNavigate).toHaveBeenCalledWith(`/client/messages/${FIRM}?c=${PERSONAL_KEY}`);

    mockSearch = new URLSearchParams(`c=${PERSONAL_KEY}`);
    rerenderPage();
    expect(openThread()).toHaveTextContent(`direct:${PERSONAL_KEY}`);
  });

  it('shows one personal tab when the server already lists the not-yet-created thread', async () => {
    api.getExact(LIST, {
      conversations: [ACME, summary({ conversationId: PERSONAL_KEY, conversationType: 'direct', clientType: 'person' })],
      totalItems: 2,
    });
    renderPage([PERSON]);

    await waitFor(() => expect(openThread()).toHaveTextContent('group:g-acme'));
    expect(screen.getAllByRole('button', { name: /Personal/ })).toHaveLength(1);
  });

  it('offers no personal thread to someone who is only an organization contact', async () => {
    api.getExact(LIST, { conversations: [ACME], totalItems: 1 });
    renderPage([{ ...PERSON, clientRecordId: 'rec-company', clientType: 'company' }]);

    await waitFor(() => expect(openThread()).toHaveTextContent('group:g-acme'));
    expect(screen.queryByRole('button', { name: /Personal/ })).not.toBeInTheDocument();
  });
});

describe('switcher unread counts', () => {
  it.each(['messages-marked-read', 'unread-count-updated'])('re-reads the counts on %s', async (eventName) => {
    api.getExact(LIST, sequence(
      { conversations: [DIRECT, { ...ACME, unreadCount: 4 }], totalItems: 2 },
      { conversations: [DIRECT, { ...ACME, unreadCount: 0 }], totalItems: 2 },
    ));
    renderPage();

    const acme = await screen.findByRole('button', { name: /Acme Corp/ });
    expect(within(acme).getByText('4')).toBeInTheDocument();

    __resetDuplicateRequestGuard();
    act(() => { window.dispatchEvent(new CustomEvent(eventName)); });

    // Red on a page that serves the counts from cache until they go stale.
    await waitFor(() => expect(within(screen.getByRole('button', { name: /Acme Corp/ })).queryByText('4')).not.toBeInTheDocument());
    expect(api.callsTo(LIST)).toHaveLength(2);
  });

  it('keeps a live conversation subscription open so activity in any thread reaches the counts', async () => {
    api.getExact(LIST, { conversations: [DIRECT, ACME], totalItems: 2 });
    renderPage();
    await screen.findByRole('button', { name: /Acme Corp/ });
    // useConversations owns the Realtime conversations channel and announces
    // every change as `unread-count-updated`, which the case above re-reads on.
    expect(mockUseConversations).toHaveBeenCalledWith({ isClient: true });
  });
});

describe('the all-firms list', () => {
  function renderList() {
    return renderWithProviders(
      <ClientPortalContext.Provider value={contextValue([PERSON])}>
        <ClientMessagesPage />
      </ClientPortalContext.Provider>,
    );
  }

  it('opens a direct row on that thread by id', async () => {
    mockUseConversations.mockReturnValue({
      conversations: [{
        conversationId: 'direct-1',
        conversationType: 'direct',
        clientId: 'test-uid',
        lawFirmId: FIRM,
        lawFirmName: 'Test Firm',
        lastMessageAt: '2026-09-01T10:00:00.000Z',
        lastMessagePreview: 'Hello',
      }],
      loading: false,
      error: null,
    });
    api.getExact('/api/messaging/client-groups', { conversations: [] });
    renderList();

    await userEvent.click(await screen.findByRole('button', { name: /Open conversation with Test Firm/ }));

    // Red on a row that opens the firm and lets the page pick the newest thread.
    expect(mockNavigate).toHaveBeenCalledWith(`/client/messages/${FIRM}?c=direct-1`);
  });

  it('opens a direct search hit on that thread by id', async () => {
    mockUseConversations.mockReturnValue({
      conversations: [{ conversationId: 'direct-1', conversationType: 'direct', lawFirmId: FIRM, lawFirmName: 'Test Firm' }],
      loading: false,
      error: null,
    });
    api.getExact('/api/messaging/client-groups', { conversations: [] });
    api.getExact('/api/messaging/search?q=invoice', {
      results: [{
        conversationId: 'direct-1',
        conversationType: 'direct',
        conversationTitle: 'Test Firm',
        lawFirmId: FIRM,
        messageId: 'm-1',
        snippet: 'Your invoice is attached',
        senderName: 'Test Firm',
        createdAt: '2026-09-01T10:00:00.000Z',
      }],
    });
    renderList();

    await userEvent.type(await screen.findByRole('textbox', { name: 'Search messages' }), 'invoice');
    await userEvent.click(await screen.findByRole('button', { name: /Your invoice is attached/ }));

    expect(mockNavigate).toHaveBeenCalledWith(`/client/messages/${FIRM}?c=direct-1`);
  });
});
