/**
 * The firm-side conversation detail page: `RequirePermission`/`RequireFeature`
 * gating `ConversationView`, driven through the REAL `useConversationMessages`
 * + `useSendMessage` hooks against a faked transport.
 *
 * Unlike the messages list page (and `BillingPage`/`TrustPage`, see
 * functionality question Q09), `ConversationView` - and the data hook it
 * owns - sits INSIDE `RequirePermission`/`RequireFeature` here, so a refused
 * viewer never fires a single thread request. That is asserted below as its
 * own case rather than assumed.
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
const mockRouterReplace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockRouterReplace, back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/messages/conv-1',
  useParams: () => useParamsMock(),
  useSearchParams: () => new URLSearchParams(),
}));

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// jsdom has no scroll implementation; `ConversationView` calls it directly on
// its message container (auto-scroll to bottom / to the "New" divider) once
// real messages render, which every test here does.
if (typeof Element !== 'undefined') {
  Element.prototype.scrollTo = Element.prototype.scrollTo || function scrollTo() {};
}

import FirmConversationPage from '@/app/lawfirm/[lawFirmId]/messages/[conversationId]/page';
import { FirmSettingsProvider } from '@/contexts/FirmSettingsContext';
import { setupApiMock } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, grantOutsider, resetPermissions } from '../../../support/permissions';

const FIRM_A = 'firm-a';
const CONV_1 = 'conv-1';
const CONV_2 = 'conv-2';
const API = 'http://localhost:5001/api';

const api = setupApiMock();

function message(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'm1',
    senderId: 'client-1',
    senderType: 'client',
    senderName: 'Jane Client',
    recipientId: 'test-uid',
    content: 'Hello counselor',
    attachments: [],
    status: 'sent',
    // Fully read by default so the auto-mark-as-read effect has nothing to do
    // and no test needs to also stub PUT /messaging/mark-read.
    readByClient: true,
    readByFirm: true,
    createdAt: '2026-01-15T12:00:00.000Z',
    updatedAt: '2026-01-15T12:00:00.000Z',
    ...overrides,
  };
}

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: CONV_1,
    clientId: 'client-1',
    clientName: 'Jane Client',
    clientEmail: 'jane@example.com',
    lawFirmId: FIRM_A,
    lawFirmName: 'Test Firm',
    lastMessageAt: '2026-01-15T12:00:00.000Z',
    lastMessagePreview: 'Hello counselor',
    unreadCountClient: 0,
    unreadCountFirm: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-15T12:00:00.000Z',
    ...overrides,
  };
}

/** Every route the thread view fetches on mount: the message history read. */
function seedThread(opts: {
  firmId?: string;
  conversationId?: string;
  messages?: ReturnType<typeof message>[];
  conversation?: ReturnType<typeof conversationRow>;
  hasMore?: boolean;
  participants?: unknown[];
} = {}) {
  const firmId = opts.firmId ?? FIRM_A;
  const conversationId = opts.conversationId ?? CONV_1;
  api.get(`/lawfirms/${firmId}/messaging/conversations/${conversationId}`, {
    messages: opts.messages ?? [message()],
    conversation: opts.conversation ?? conversationRow({ conversationId }),
    hasMore: opts.hasMore ?? false,
    participants: opts.participants ?? [],
  });
}

function renderConversationPage(firmId: string = FIRM_A) {
  return renderWithProviders(
    <FirmSettingsProvider lawFirmId={firmId} initialSettings={{ features: { messaging: true } as never }}>
      <FirmConversationPage />
    </FirmSettingsProvider>,
  );
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A, conversationId: CONV_1 });
});

afterEach(() => {
  resetPermissions();
  jest.clearAllMocks();
});

describe('loaded content', () => {
  it('shows the real conversation header and its messages', async () => {
    seedThread({
      messages: [message({ content: 'Hello counselor' })],
      conversation: conversationRow({ clientName: 'Jane Client' }),
    });

    renderConversationPage();

    expect(await screen.findByRole('heading', { name: 'Jane Client' })).toBeInTheDocument();
    expect(screen.getByText('Hello counselor')).toBeInTheDocument();
  });
});

describe('a meaningful empty state', () => {
  it('says this is the start of the conversation rather than leaving the pane blank', async () => {
    seedThread({ messages: [], conversation: conversationRow({ clientName: 'Jane Client' }) });

    renderConversationPage();

    await screen.findByRole('heading', { name: 'Jane Client' });
    expect(screen.getByText('This is the start of your conversation.')).toBeInTheDocument();
  });
});

describe('an API failure, with retry', () => {
  it('shows the real error rather than a blank pane', async () => {
    api.get(`/lawfirms/${FIRM_A}/messaging/conversations/${CONV_1}`, {
      status: 500,
      body: { error: 'messaging service unavailable' },
    });

    renderConversationPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/messaging service unavailable/i);
  });

  it('offers a way to retry the failed load', async () => {
    api.get(`/lawfirms/${FIRM_A}/messaging/conversations/${CONV_1}`, {
      status: 500,
      body: { error: 'messaging service unavailable' },
    });

    renderConversationPage();

    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('recovers the real thread once the retry succeeds', async () => {
    let attempt = 0;
    api.get(`/lawfirms/${FIRM_A}/messaging/conversations/${CONV_1}`, () => {
      attempt += 1;
      if (attempt === 1) return { status: 500, body: { error: 'messaging service unavailable' } };
      return {
        messages: [message({ content: 'Hello counselor' })],
        conversation: conversationRow({ clientName: 'Jane Client' }),
        hasMore: false,
        participants: [],
      };
    });

    renderConversationPage();

    const retry = await screen.findByRole('button', { name: 'Try again' });
    await userEvent.click(retry);

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(await screen.findByText('Hello counselor')).toBeInTheDocument();
  });
});

describe('narrow role behavior', () => {
  it('turns away a caller with no membership before any thread data loads', async () => {
    grantOutsider();
    seedThread();

    renderConversationPage();

    expect(await screen.findByText('You do not have access to this area')).toBeInTheDocument();
    // ConversationView (and its data hook) is mounted INSIDE RequirePermission
    // here, unlike the messages list page, so a refused viewer's render never
    // reaches the component that would fire the request.
    expect(api.callsTo(`/messaging/conversations/${CONV_1}`)).toHaveLength(0);
  });

  it('lets a baseline member view the thread and reply', async () => {
    grantBaselineMember();
    seedThread({ conversation: conversationRow({ clientName: 'Jane Client' }) });

    renderConversationPage();

    expect(await screen.findByRole('heading', { name: 'Jane Client' })).toBeInTheDocument();
    // messaging.send is baseline, so every real member keeps the compose box.
    expect(screen.getByPlaceholderText('Type a message...')).toBeInTheDocument();
  });
});

describe('a successful action: sending a message', () => {
  it('shows the sent message immediately and posts it to the server', async () => {
    seedThread({ messages: [message({ content: 'Hello counselor' })], conversation: conversationRow({ clientName: 'Jane Client' }) });
    api.postExact(`${API}/lawfirms/${FIRM_A}/messaging/send`, { messageId: 'm2', conversationId: CONV_1 });

    renderConversationPage();

    await screen.findByText('Hello counselor');

    const box = screen.getByPlaceholderText('Type a message...');
    await userEvent.type(box, 'On my way to the courthouse');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('On my way to the courthouse')).toBeInTheDocument();
    expect(api.callsTo('/messaging/send')).toHaveLength(1);
    expect(api.callsTo('/messaging/send')[0].body).toMatchObject({
      content: 'On my way to the courthouse',
      clientId: 'client-1',
      lawFirmId: FIRM_A,
    });
  });
});

describe('a refused action: sending fails', () => {
  it('rolls back a refused optimistic message', async () => {
    seedThread({ messages: [], conversation: conversationRow({ clientName: 'Jane Client' }) });
    api.postExact(`${API}/lawfirms/${FIRM_A}/messaging/send`, {
      status: 403,
      body: { error: 'You do not have permission to send messages in this conversation' },
    });

    renderConversationPage();

    await screen.findByRole('heading', { name: 'Jane Client' });
    const box = screen.getByPlaceholderText('Type a message...');
    await userEvent.type(box, 'Can we reschedule?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByRole('alert');
    // The composer gets the draft back; the thread must not keep the bubble.
    const thread = screen.getByRole('region', { name: 'Conversation messages' });
    expect(within(thread).queryByText('Can we reschedule?')).not.toBeInTheDocument();
  });

  it('gives the refused draft back to the composer', async () => {
    seedThread({ messages: [], conversation: conversationRow({ clientName: 'Jane Client' }) });
    api.postExact(`${API}/lawfirms/${FIRM_A}/messaging/send`, {
      status: 500,
      body: { error: 'messaging service unavailable' },
    });

    renderConversationPage();

    await screen.findByRole('heading', { name: 'Jane Client' });
    const box = screen.getByPlaceholderText('Type a message...');
    await userEvent.type(box, 'Please keep this text');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByRole('alert');
    await waitFor(() => expect(box).toHaveValue('Please keep this text'));
  });
});

describe('the first message to a client who has no thread yet', () => {
  const SYNTHETIC = `${FIRM_A}_client-1`;

  it('moves the view, the url and the inbox onto the conversation the send created', async () => {
    useParamsMock.mockReturnValue({ lawFirmId: FIRM_A, conversationId: SYNTHETIC });
    api.get(`/lawfirms/${FIRM_A}/messaging/conversations/${SYNTHETIC}`, {
      status: 404,
      body: { error: 'Conversation not found' },
    });
    api.postExact(`${API}/lawfirms/${FIRM_A}/messaging/send`, { messageId: 'm-new', conversationId: 'conv-new' });
    seedThread({
      conversationId: 'conv-new',
      messages: [message({ messageId: 'm-new', senderId: 'test-uid', senderType: 'firm_member', content: 'First hello' })],
      conversation: conversationRow({ conversationId: 'conv-new', clientName: 'Jane Client' }),
    });

    const { queryClient } = renderConversationPage();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    await screen.findByText('This is the start of your conversation.');

    await userEvent.type(screen.getByPlaceholderText('Type a message...'), 'First hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    // The real thread is read (and subscribed) instead of the synthetic key the
    // backend can never resolve, which is what left the bubble on "Sending".
    await waitFor(() => expect(api.callsTo('/messaging/conversations/conv-new')).toHaveLength(1));
    expect(api.callsTo(`/messaging/conversations/${SYNTHETIC}`)).toHaveLength(1);
    expect(mockRouterReplace).toHaveBeenCalledWith(`/lawfirm/${FIRM_A}/messages/conv-new`);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['firmConversations', FIRM_A] });
    await waitFor(() => expect(screen.getAllByText('First hello')).toHaveLength(1));
  });
});

describe('a pending send when the viewer switches conversation', () => {
  it('does not carry the pending bubble into the next thread', async () => {
    seedThread({ messages: [message({ content: 'Hello counselor' })] });
    seedThread({
      conversationId: CONV_2,
      messages: [message({ messageId: 'm2', content: 'Other thread reply' })],
      conversation: conversationRow({ conversationId: CONV_2, clientName: 'Other Client' }),
    });
    api.postExact(`${API}/lawfirms/${FIRM_A}/messaging/send`, {
      delayMs: 300,
      body: { messageId: 'm9', conversationId: CONV_1 },
    });

    const { rerender } = renderConversationPage();
    await screen.findByText('Hello counselor');
    await userEvent.type(screen.getByPlaceholderText('Type a message...'), 'Meant for Jane only');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Meant for Jane only')).toBeInTheDocument();

    useParamsMock.mockReturnValue({ lawFirmId: FIRM_A, conversationId: CONV_2 });
    rerender(
      <FirmSettingsProvider lawFirmId={FIRM_A} initialSettings={{ features: { messaging: true } as never }}>
        <FirmConversationPage />
      </FirmSettingsProvider>,
    );

    expect(await screen.findByText('Other thread reply')).toBeInTheDocument();
    expect(screen.queryByText('Meant for Jane only')).not.toBeInTheDocument();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(screen.queryByText('Meant for Jane only')).not.toBeInTheDocument();
  });
});

describe('a conversation switch while a request is pending', () => {
  it('never lets a slow response for the old conversation land as the new conversation\'s thread', async () => {
    seedThread({
      conversationId: CONV_2,
      messages: [message({ messageId: 'm2', content: 'New Fast Reply', senderType: 'firm_member', senderId: 'test-uid' })],
      conversation: conversationRow({ conversationId: CONV_2, clientName: 'New Fast Client' }),
    });
    api.get(`/lawfirms/${FIRM_A}/messaging/conversations/${CONV_1}`, {
      delayMs: 200,
      body: {
        messages: [message({ messageId: 'm1', content: 'Old Slow Reply' })],
        conversation: conversationRow({ conversationId: CONV_1, clientName: 'Old Slow Client' }),
        hasMore: false,
        participants: [],
      },
    });

    const { rerender } = renderConversationPage();

    // Conversation 1's slow response is still in flight when the viewer
    // navigates to conversation 2 (e.g. clicking another row in the inbox
    // list, which does not remount this page's component instance).
    useParamsMock.mockReturnValue({ lawFirmId: FIRM_A, conversationId: CONV_2 });
    rerender(
      <FirmSettingsProvider lawFirmId={FIRM_A} initialSettings={{ features: { messaging: true } as never }}>
        <FirmConversationPage />
      </FirmSettingsProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'New Fast Client' })).toBeInTheDocument();
    expect(await screen.findByText('New Fast Reply')).toBeInTheDocument();

    // Even once conversation 1's slow response finally arrives, it must not
    // overwrite the thread now showing conversation 2.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByRole('heading', { name: 'New Fast Client' })).toBeInTheDocument();
    expect(screen.queryByText('Old Slow Reply')).not.toBeInTheDocument();
    expect(screen.queryByText('Old Slow Client')).not.toBeInTheDocument();
  });
});



/**
 * Late content (date dividers, sign-document cards) grows the thread after the
 * first positioning pass. For about a second after opening, a ResizeObserver on
 * the message list re-runs that positioning so the reader stays at the anchor;
 * after that window a resize must leave the reader's scroll alone.
 */
describe('re-anchoring the thread while late content renders', () => {
  type ResizeCallback = () => void;
  const observers: Array<{ callback: ResizeCallback; targets: Element[]; disconnect: jest.Mock }> = [];
  const OriginalResizeObserver = window.ResizeObserver;

  beforeEach(() => {
    observers.length = 0;
    class CapturingResizeObserver {
      private record: (typeof observers)[number];
      constructor(callback: ResizeCallback) {
        this.record = { callback, targets: [], disconnect: jest.fn() };
        observers.push(this.record);
      }
      observe(target: Element) { this.record.targets.push(target); }
      unobserve() {}
      disconnect() { this.record.disconnect(); }
    }
    window.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    window.ResizeObserver = OriginalResizeObserver;
  });

  /** The observer on the message list, and the scroll container it sits in. */
  async function openThread() {
    seedThread({ messages: [message({ content: 'Hello counselor' })] });
    const view = renderConversationPage();
    await screen.findByText('Hello counselor');
    const listObserver = observers.find((o) =>
      o.targets.some((t) => t.parentElement?.classList.contains('bg-messages-area')));
    expect(listObserver).toBeDefined();
    const container = listObserver!.targets[0].parentElement as HTMLElement;
    // jsdom lays nothing out, so give the thread a height for the anchor to reach.
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 900 });
    container.scrollTop = 0;
    return { view, listObserver: listObserver!, container };
  }

  it('scrolls back to the anchor when the list grows during the opening window', async () => {
    const { listObserver, container } = await openThread();

    act(() => listObserver.callback());

    // Nothing is unread, so the anchor is the newest message at the bottom.
    expect(container.scrollTop).toBe(900);
  });

  it('leaves the scroll position alone once the opening window has passed', async () => {
    const { listObserver, container } = await openThread();

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    container.scrollTop = 0;
    act(() => listObserver.callback());

    expect(container.scrollTop).toBe(0);
  });

  it('disconnects the observer when the thread unmounts', async () => {
    const { view, listObserver } = await openThread();
    expect(listObserver.disconnect).not.toHaveBeenCalled();

    view.unmount();

    expect(listObserver.disconnect).toHaveBeenCalledTimes(1);
  });
});
