/**
 * The firm messages inbox: `RequirePermission`/`RequireFeature` gating
 * `useConversations` + `ConversationList`, the entry point for every
 * conversation in the firm.
 *
 * `messages.service` and `requestDeduplicator` run for real against a faked
 * transport, so a wrong url, a swallowed error, or a stale response reaching a
 * switched firm fails the spec instead of a stubbed hook quietly returning
 * whatever the test handed it. Supabase Realtime is mocked at the module
 * boundary (as the hook contract tests do) rather than left to rely on the
 * test environment lacking `NEXT_PUBLIC_SUPABASE_URL`.
 */
jest.unmock('@/services/messages.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/lib/supabase/realtimeClient', () => ({
  authorizeRealtime: jest.fn().mockResolvedValue(null),
  getRealtimeClient: jest.fn(() => null),
  retainRealtime: jest.fn(),
  releaseRealtime: jest.fn(),
  onRealtimeResume: jest.fn(() => () => {}),
}));

const useParamsMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/messages',
  useParams: () => useParamsMock(),
  useSearchParams: () => new URLSearchParams(),
}));

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import FirmMessagesPage from '@/app/lawfirm/[lawFirmId]/messages/page';
import { FirmSettingsProvider } from '@/contexts/FirmSettingsContext';
import { setupApiMock } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, grantOutsider, resetPermissions } from '../../../support/permissions';
import type { Conversation } from '@/types';

const FIRM_A = 'firm-a';
const FIRM_B = 'firm-b';
const API = 'http://localhost:5001/api';

const api = setupApiMock();

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    conversationId: 'conv-1',
    clientId: 'client-1',
    clientName: 'Jane Client',
    clientEmail: 'jane@example.com',
    lawFirmId: FIRM_A,
    lawFirmName: 'Test Firm',
    lastMessageAt: '2026-01-15T12:00:00.000Z',
    lastMessagePreview: 'See you at the hearing',
    unreadCountClient: 0,
    unreadCountFirm: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-15T12:00:00.000Z',
    conversationType: 'direct',
    ...overrides,
  } as Conversation;
}

/**
 * Every route the inbox page fetches on mount: the paged inbox itself, plus
 * the archive-toggle count probe (`?limit=1&archived=true`) the active view
 * always fires alongside it (see `FirmMessagesPage`'s `archivedTotal` query).
 */
function seedInbox(
  firmId: string,
  opts: { conversations?: Conversation[]; totalItems?: number; archivedTotal?: number } = {},
) {
  const conversations = opts.conversations ?? [];
  const totalItems = opts.totalItems ?? conversations.length;
  api.get(`/lawfirms/${firmId}/messaging/inbox`, (call) => {
    const archived = call.query.archived?.[0] === 'true';
    if (archived) return { conversations: [], totalItems: opts.archivedTotal ?? 0 };
    return { conversations, totalItems };
  });
}

/** The main inbox list fails once, then (on retry) succeeds; the archive-count
 *  probe always succeeds so only the list read is under test. */
function seedFailingInbox(firmId: string, message = 'messaging service unavailable') {
  let attempt = 0;
  api.get(`/lawfirms/${firmId}/messaging/inbox`, (call) => {
    const archived = call.query.archived?.[0] === 'true';
    if (archived) return { conversations: [], totalItems: 0 };
    attempt += 1;
    if (attempt === 1) return { status: 500, body: { error: message } };
    return { conversations: [conversation()], totalItems: 1 };
  });
}

function renderMessagesPage(firmId: string = FIRM_A) {
  return renderWithProviders(
    <FirmSettingsProvider lawFirmId={firmId} initialSettings={{ features: { messaging: true } as never }}>
      <FirmMessagesPage />
    </FirmSettingsProvider>,
  );
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A });
});

afterEach(() => {
  resetPermissions();
  jest.clearAllMocks();
});

describe('loaded content', () => {
  it('shows the real conversations returned by the server', async () => {
    seedInbox(FIRM_A, {
      conversations: [conversation({ clientName: 'Jane Client', lastMessagePreview: 'See you at the hearing' })],
      totalItems: 1,
    });

    renderMessagesPage();

    expect(await screen.findByText('Jane Client')).toBeInTheDocument();
    expect(screen.getByText('See you at the hearing')).toBeInTheDocument();
    expect(screen.getByText(/You have/)).toHaveTextContent('You have 1 conversation.');
  });
});

describe('a meaningful empty state', () => {
  it('says no conversations yet rather than rendering a blank list', async () => {
    seedInbox(FIRM_A);

    renderMessagesPage();

    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
    expect(screen.getByText('Start a new message to begin a conversation with a client')).toBeInTheDocument();
  });
});

describe('an API failure, with retry', () => {
  it('shows the real error rather than a blank inbox', async () => {
    seedFailingInbox(FIRM_A);

    renderMessagesPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/messaging service unavailable/i);
  });

  it('offers a way to retry the failed load', async () => {
    seedFailingInbox(FIRM_A);

    renderMessagesPage();

    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('recovers the real list once the retry succeeds', async () => {
    seedFailingInbox(FIRM_A);

    renderMessagesPage();

    const retry = await screen.findByRole('button', { name: 'Try again' });
    await userEvent.click(retry);

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(await screen.findByText('Jane Client')).toBeInTheDocument();
  });
});

describe('narrow role behavior', () => {
  it('gives a baseline member the compose and archive controls, since messaging.send is baseline for every real member', async () => {
    grantBaselineMember();
    seedInbox(FIRM_A, { conversations: [conversation()], totalItems: 1 });

    renderMessagesPage();

    expect(await screen.findByText('Jane Client')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Message/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Conversation actions' })).toBeInTheDocument();
  });

  it('turns away a caller with no membership at all', async () => {
    grantOutsider();
    seedInbox(FIRM_A, { conversations: [conversation()], totalItems: 1 });

    renderMessagesPage();

    expect(await screen.findByText('You do not have access to this area')).toBeInTheDocument();
  });
});

describe('a successful action: archiving a conversation', () => {
  it('archives the conversation and removes it from the inbox', async () => {
    let listCall = 0;
    api.get(`/lawfirms/${FIRM_A}/messaging/inbox`, (call) => {
      const archived = call.query.archived?.[0] === 'true';
      if (archived) return { conversations: [], totalItems: 0 };
      listCall += 1;
      // The refresh AFTER a successful archive re-requests the same window and
      // gets the now-empty inbox.
      return listCall === 1 ? { conversations: [conversation()], totalItems: 1 } : { conversations: [], totalItems: 0 };
    });
    api.putExact(`${API}/lawfirms/${FIRM_A}/messaging/conversations/conv-1/archive`, { message: 'ok', archived: true });

    renderMessagesPage();

    await screen.findByText('Jane Client');
    await userEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));

    await waitFor(() => expect(screen.queryByText('Jane Client')).not.toBeInTheDocument());
    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
    expect(api.callsTo('/messaging/conversations/conv-1/archive')).toHaveLength(1);
  });
});

describe('a refused action: the archive fails', () => {
  it('tells the user the conversation was not archived, and leaves it in the inbox', async () => {
    seedInbox(FIRM_A, { conversations: [conversation()], totalItems: 1 });
    api.putExact(`${API}/lawfirms/${FIRM_A}/messaging/conversations/conv-1/archive`, {
      status: 403,
      body: { error: 'You do not have permission to archive this conversation' },
    });

    renderMessagesPage();

    await screen.findByText('Jane Client');
    await userEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));

    expect(await screen.findByText(/do not have permission to archive/i)).toBeInTheDocument();
    // Still in the inbox - the archive never actually happened.
    expect(screen.getByText('Jane Client')).toBeInTheDocument();
  });
});

describe('a law firm switch while a request is pending', () => {
  it('never lets a slow response for the old firm land as the new firm\'s inbox', async () => {
    seedInbox(FIRM_B, {
      conversations: [conversation({ conversationId: 'conv-b', clientId: 'client-b', clientName: 'Firm B Client', lawFirmId: FIRM_B })],
      totalItems: 1,
    });
    api.get(`/lawfirms/${FIRM_A}/messaging/inbox`, (call) => {
      const archived = call.query.archived?.[0] === 'true';
      if (archived) return { conversations: [], totalItems: 0 };
      return { delayMs: 200, body: { conversations: [conversation({ clientName: 'Firm A Client' })], totalItems: 1 } };
    });

    const { rerender } = renderMessagesPage();

    // Firm A's slow request is still in flight when the viewer switches firms.
    useParamsMock.mockReturnValue({ lawFirmId: FIRM_B });
    rerender(
      <FirmSettingsProvider lawFirmId={FIRM_B} initialSettings={{ features: { messaging: true } as never }}>
        <FirmMessagesPage />
      </FirmSettingsProvider>,
    );

    expect(await screen.findByText('Firm B Client')).toBeInTheDocument();

    // Even once firm A's slow response finally arrives, it must not overwrite
    // the inbox now attributed to firm B.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByText('Firm B Client')).toBeInTheDocument();
    expect(screen.queryByText('Firm A Client')).not.toBeInTheDocument();
  });
});
